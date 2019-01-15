import * as arraySort from 'array-sort';
import * as Promise from 'bluebird';
import * as _ from 'lodash';
import { InternalRequestError } from '@resin/pinejs/out/sbvr-api/errors';
import * as deviceTypesLib from '@resin.io/device-types';
import * as semver from 'resin-semver';
import { sbvrUtils, PinejsClient } from '../../platform';
import { captureException } from '../../platform/errors';
import {
	getCompressedSize,
	getDeviceTypeJson,
	getIsIgnored,
} from './build-info-facade';
import { getImageKey, IMAGE_STORAGE_PREFIX, listFolders } from './storage';
import { db, updateOrInsertModel } from '../../platform';

export const { BadRequestError, NotFoundError } = sbvrUtils;

export type DeviceType = deviceTypesLib.DeviceType;

export class InvalidDeviceTypeError extends BadRequestError {}

export class UnknownDeviceTypeError extends NotFoundError {
	constructor(slug: string) {
		super(`Unknown device type ${slug}`);
	}
}

export class UnknownVersionError extends NotFoundError {
	constructor(slug: string, buildId: string) {
		super(`Device ${slug} not found for ${buildId} version`);
	}
}

interface DeviceTypeWithAliases extends DeviceType {
	aliases?: string[];
}

interface BuildInfo {
	ignored: boolean;
	deviceType: DeviceType;
}

interface DeviceTypeInfo {
	latest: BuildInfo;
	versions: string[];
}

const SPECIAL_SLUGS = ['edge'];
const RETRY_DELAY = 2000; // ms
const DEVICE_TYPES_CACHE_EXPIRATION = 5 * 60 * 1000; // 5 mins

const syncSettings: { map: Dictionary<string> } = {
	map: {},
};

export function setSyncMap(map: Dictionary<string>) {
	syncSettings.map = map;
}

function sortBuildIds(ids: string[]): string[] {
	return arraySort(
		ids,
		(a: string, b: string) => {
			return (semver.prerelease(a) ? 1 : 0) - (semver.prerelease(b) ? 1 : 0);
		},
		semver.rcompare,
	);
}

const getBuildData = (slug: string, buildId: string) => {
	return Promise.join(
		getIsIgnored(slug, buildId),
		getDeviceTypeJson(slug, buildId).catchReturn(undefined),
		(ignored, deviceType) => {
			const buildInfo = {
				ignored,
				deviceType,
			};

			return buildInfo;
		},
	);
};

const getFirstValidBuild = (
	slug: string,
	versions: string[],
): Promise<BuildInfo | undefined> => {
	if (_.isEmpty(versions)) {
		return Promise.resolve() as Promise<BuildInfo | undefined>;
	}

	const buildId = versions[0];
	return getBuildData(slug, buildId)
		.catch(err => {
			captureException(
				err,
				`Failed to get device type build data for ${slug}/${buildId}`,
			);
		})
		.then(buildInfo => {
			if (buildInfo && !buildInfo.ignored && buildInfo.deviceType) {
				// TS can't infer this correctly and gets confused when
				// checking it against the Promise return value
				return buildInfo as BuildInfo;
			}

			return getFirstValidBuild(slug, _.tail(versions));
		});
};

function fetchDeviceTypes(): Promise<Dictionary<DeviceTypeInfo>> {
	const result: Dictionary<DeviceTypeInfo> = {};
	getIsIgnored.clear();
	getDeviceTypeJson.clear();
	return listFolders(IMAGE_STORAGE_PREFIX)
		.map(slug => {
			return listFolders(getImageKey(slug))
				.then(builds => {
					if (_.isEmpty(builds)) {
						return;
					}

					const sortedBuilds = sortBuildIds(builds);
					return getFirstValidBuild(slug, sortedBuilds).then(
						latestBuildInfo => {
							if (!latestBuildInfo) {
								return;
							}

							result[slug] = {
								versions: builds,
								latest: latestBuildInfo,
							};

							_.forEach(
								(latestBuildInfo.deviceType as DeviceTypeWithAliases).aliases,
								alias => {
									result[alias] = result[slug];
								},
							);
						},
					);
				})
				.catch(err => {
					captureException(
						err,
						`Failed to find a valid build for device type ${slug}`,
					);
				})
				.return(slug);
		})
		.then(slugs => {
			if (_.isEmpty(result) && !_.isEmpty(slugs)) {
				throw new InternalRequestError('Could not retrieve any device type');
			}
		})
		.return(result)
		.catch(err => {
			captureException(err, 'Failed to get device types');
			return Promise.delay(RETRY_DELAY).then(fetchDeviceTypes);
		});
}

let deviceTypesCache: Promise<Dictionary<DeviceTypeInfo>> | undefined;

function updateDeviceTypesCache(
	freshDeviceTypes: Promise<Dictionary<DeviceTypeInfo>>,
) {
	if (!deviceTypesCache) {
		deviceTypesCache = freshDeviceTypes;
		return freshDeviceTypes;
	}
	return Promise.join(
		deviceTypesCache,
		freshDeviceTypes,
		(cachedDeviceTypes, freshDeviceTypes) => {
			const removedDeviceTypes = _.difference(
				_.keys(cachedDeviceTypes),
				_.keys(freshDeviceTypes),
			);
			removedDeviceTypes.forEach(
				removedDeviceType => delete cachedDeviceTypes[removedDeviceType],
			);

			_.forEach(freshDeviceTypes, (freshDeviceType, slug) => {
				const cachedDeviceType = cachedDeviceTypes[slug];
				if (!cachedDeviceType) {
					cachedDeviceTypes[slug] = freshDeviceType;
				}
			});
		},
	).tapCatch(err => {
		captureException(err, 'Failed to update device type cache');
	});
}

export function syncDataModel(
	types: Dictionary<DeviceTypeInfo>,
	propertyMap: Dictionary<string>,
) {
	return db.transaction(tx => {
		return Promise.each(_.map(types), deviceTypeInfo => {
			const deviceType = deviceTypeInfo.latest.deviceType;
			const body: AnyObject = {};
			_.forEach(propertyMap, (target, source) => {
				body[target] = (deviceType as AnyObject)[source];
			});
			return updateOrInsertModel(
				'device_type',
				{
					slug: deviceType.slug,
				},
				body,
				tx,
			);
		});
	});
}

function fetchDeviceTypesAndReschedule(): Promise<Dictionary<DeviceTypeInfo>> {
	const promise = fetchDeviceTypes()
		.tap(() => {
			// when the promise gets resolved, cache it
			deviceTypesCache = promise;
		})
		.finally(() => {
			// schedule a re-run to update the local cache
			Promise.delay(DEVICE_TYPES_CACHE_EXPIRATION)
				.then(fetchDeviceTypesAndReschedule)
				.catch(err => {
					captureException(err, 'Failed to re-fetch device types');
				});

			// silence the promise created but not returned warning
			return null;
		});

	// if the cache is still empty, use this promise so that
	// we do not start a second set of requests to s3
	// in case another api request comes before the first completes
	if (!deviceTypesCache) {
		deviceTypesCache = promise;
	} else {
		updateDeviceTypesCache(promise);
	}

	return promise.tap(deviceTypeInfos => {
		return syncDataModel(deviceTypeInfos, syncSettings.map);
	});
}

function getDeviceTypes(): Promise<Dictionary<DeviceTypeInfo>> {
	// Always return the local cache if populated
	if (deviceTypesCache) {
		return deviceTypesCache;
	}

	return fetchDeviceTypesAndReschedule();
}

export const getAccessibleSlugs = (
	api: PinejsClient,
	slugs?: string[],
): Promise<string[]> => {
	const options: AnyObject = {
		$select: ['slug'],
	};
	if (slugs && slugs.length > 1) {
		options['$filter'] = {
			$in: { slug: slugs },
		};
	} else if (slugs && slugs.length == 1) {
		options['$filter'] = {
			slug: slugs[0],
		};
	}
	return api
		.get({
			resource: 'device_type',
			options,
		})
		.then((accessibleDeviceTypes: { slug: string }[]) => {
			return _.map(accessibleDeviceTypes, 'slug');
		});
};

export const findDeviceTypeInfoBySlug = (
	slug: string,
	api: PinejsClient,
): Promise<DeviceTypeInfo> =>
	getAccessibleSlugs(api, [slug])
		.then((accessibleDeviceTypes: string[]) => {
			if (accessibleDeviceTypes.length > 0) {
				if (_.includes(accessibleDeviceTypes, slug)) {
					// We can access the device type slug
					return;
				}
			}
			// We cannot access the device type
			throw new UnknownDeviceTypeError(slug);
		})
		.then(getDeviceTypes)
		.then(deviceTypeInfos => {
			// the slug can be an alias,
			// since the Dictionary also has props for the aliases
			const deviceTypeInfo = deviceTypeInfos[slug];
			if (!deviceTypeInfo || !deviceTypeInfo.latest) {
				throw new UnknownDeviceTypeError(slug);
			}
			return deviceTypeInfos[slug];
		});
// TODO: filter device to be accessible for req

export const validateSlug = (slug?: string) => {
	if (slug == null || !/^[\w-]+$/.test(slug)) {
		throw new InvalidDeviceTypeError('Invalid device type');
	}
	return slug;
};

export const deviceTypes = (api: PinejsClient): Promise<DeviceType[]> => {
	return getDeviceTypes()
		.then(deviceTypesInfos => {
			// exclude aliases
			return _(deviceTypesInfos)
				.filter(
					(deviceTypesInfo, slug) =>
						deviceTypesInfo.latest.deviceType.slug === slug,
				)
				.map(deviceTypesInfo => deviceTypesInfo.latest.deviceType)
				.value();
		})
		.then(deviceTypes => {
			return getAccessibleSlugs(api).then((accessibleDeviceTypes: string[]) => {
				return _.filter(deviceTypes, o => {
					return _.includes(accessibleDeviceTypes, o.slug);
				});
			});
		});
};

export const findBySlug = (
	slug: string,
	api: PinejsClient,
): Promise<DeviceType> =>
	deviceTypes(api)
		.then(deviceTypes => deviceTypesLib.findBySlug(deviceTypes, slug))
		.then(deviceType => {
			if (deviceType == null) {
				throw new UnknownDeviceTypeError(slug);
			}
			// use a .then() & return instead of .tap(),
			// so that the result is inferred as non-nullable
			return deviceType;
		});

export const normalizeDeviceType = (
	slug: string,
	api: PinejsClient,
): Promise<string> => {
	if (SPECIAL_SLUGS.includes(slug)) {
		return Promise.resolve(slug);
	}

	return deviceTypes(api)
		.then(deviceTypes => deviceTypesLib.normalizeDeviceType(deviceTypes, slug))
		.tap(normalizedSlug => {
			if (normalizedSlug == null) {
				throw new UnknownDeviceTypeError(slug);
			}
		});
};

export const getImageSize = (
	slug: string,
	buildId: string,
	api: PinejsClient,
) => {
	return findDeviceTypeInfoBySlug(slug, api).then(deviceTypeInfo => {
		const deviceType = deviceTypeInfo.latest.deviceType;
		const normalizedSlug = deviceType.slug;

		if (buildId === 'latest') {
			buildId = deviceType.buildId;
		}

		if (!deviceTypeInfo.versions.includes(buildId)) {
			throw new UnknownVersionError(slug, buildId);
		}

		return Promise.join(
			getIsIgnored(normalizedSlug, buildId),
			getDeviceTypeJson(normalizedSlug, buildId),
			(ignored, hasDeviceTypeJson) => {
				if (ignored || !hasDeviceTypeJson) {
					throw new UnknownVersionError(slug, buildId);
				}

				return getCompressedSize(normalizedSlug, buildId).tapCatch(err => {
					captureException(
						err,
						`Failed to get device type ${slug} compressed size for version ${buildId}`,
					);
				});
			},
		);
	});
};

export interface ImageVersions {
	versions: string[];
	latest: string;
}

export const getDeviceTypeIdBySlug = (
	slug: string,
	api: PinejsClient,
): Promise<{ id: number; slug: string }> => {
	return normalizeDeviceType(slug, api)
		.then(deviceType => {
			return api.get({
				resource: 'device_type',
				options: {
					$select: ['id', 'slug'],
					$filter: {
						slug: deviceType,
					},
				},
			});
		})
		.then(([dt]: { id: number; slug: string }[]) => {
			return dt;
		});
};

export const getImageVersions = (
	slug: string,
	api: PinejsClient,
): Promise<ImageVersions> => {
	return findDeviceTypeInfoBySlug(slug, api).then(deviceTypeInfo => {
		const deviceType = deviceTypeInfo.latest.deviceType;
		const normalizedSlug = deviceType.slug;

		return Promise.map(deviceTypeInfo.versions, buildId => {
			return Promise.props({
				buildId,
				ignored: getIsIgnored(normalizedSlug, buildId),
				hasDeviceTypeJson: getDeviceTypeJson(normalizedSlug, buildId),
			}).catchReturn(undefined);
		}).then(versionInfo => {
			const filteredInfo = versionInfo.filter(
				(buildInfo): buildInfo is NonNullable<typeof buildInfo> =>
					buildInfo != null &&
					!!buildInfo.hasDeviceTypeJson &&
					!buildInfo.ignored,
			);
			if (_.isEmpty(filteredInfo) && !_.isEmpty(deviceTypeInfo.versions)) {
				throw new InternalRequestError(
					`Could not retrieve any image version for device type ${slug}`,
				);
			}

			const buildIds = filteredInfo.map(({ buildId }) => buildId);
			return {
				versions: buildIds,
				latest: buildIds[0],
			};
		});
	});
};
