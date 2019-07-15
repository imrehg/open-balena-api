import * as _ from 'lodash';
import * as Promise from 'bluebird';

import * as deviceTypes from '../../lib/device-types';
import { postDevices } from '../../lib/device-proxy';
import { Default as DefaultApplicationType } from '../../lib/application-types';

import {
	sbvrUtils,
	root,
	PinejsClient,
	createActor,
	getCurrentRequestAffectedIds,
	addDeleteHookForDependents,
} from '../../platform';
const { BadRequestError, ConflictError } = sbvrUtils;
import { captureException } from '../../platform/errors';

import { Hooks } from '@resin/pinejs/out/sbvr-api/sbvr-utils';
import { VPN_HOST, VPN_PORT } from '../../lib/config';

const checkDependentApplication: Hooks['POSTPARSE'] = ({ request, api }) => {
	const dependsOnApplicationId = request.values.belongs_to__application;
	if (dependsOnApplicationId != null) {
		api
			.get({
				resource: 'application',
				id: dependsOnApplicationId,
				options: {
					$select: ['id'],
				},
			})
			.then(dependsOnApplication => {
				if (dependsOnApplication == null) {
					throw new Error('Invalid application to depend upon');
				}
			});
	}
};

const throwErrorIfCommitChangeIsInvalid = (
	api: PinejsClient,
	commit: string,
	appId: number,
) =>
	api
		.get({
			resource: 'release/$count',
			options: {
				$filter: {
					commit,
					belongs_to__application: appId,
					status: 'success',
				},
			},
		})
		.then(count => {
			if (count === 0) {
				throw new sbvrUtils.BadRequestError(
					'Commit is either invalid, or linked to an unsuccessful release',
				);
			}
		});

sbvrUtils.addPureHook('POST', 'resin', 'application', {
	POSTPARSE: createActor,
});

sbvrUtils.addPureHook('POST', 'resin', 'application', {
	POSTPARSE: args => {
		const { req, request, api } = args;
		const appName = request.values.app_name;

		if (request.values.application_type == null) {
			request.values.application_type = DefaultApplicationType.id;
		}

		if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
			throw new Error('App name may only contain [a-zA-Z0-9_-].');
		}

		const promises: AnyObject[] = [];
		if (
			request.values.device_type != null &&
			request.values.is_for__device_type == null
		) {
			// translate device_type to is_for__device_type
			promises.push(
				deviceTypes
					.getDeviceTypeIdBySlug(request.values.device_type, api)
					.then(dt => {
						if (dt) {
							request.values.is_for__device_type = dt.id;
							return;
						}
						throw new Error('Invalid device type value');
					}),
			);
		}

		const resolveDeviceTypePromise = Promise.all(promises)
			.then(() => {
				if (!request.values.is_for__device_type) {
					throw new Error('No device type specified for application');
				}
			})
			.then(() => {
				return api.get({
					resource: 'device_type',
					id: request.values.is_for__device_type,
					options: {
						$select: ['slug'],
					},
				});
			})
			.then((dt: { slug: string }) => {
				if (!dt) {
					throw new deviceTypes.UnknownDeviceTypeError('');
				}
				return deviceTypes.findBySlug(dt.slug, api);
			});

		return Promise.all([
			resolveDeviceTypePromise,
			checkDependentApplication(args),
		])
			.then(() => {
				request.values.VPN_host = VPN_HOST;
				request.values.VPN_port = VPN_PORT;
				request.values.should_track_latest_release = true;
				if (request.values.slug == null) {
					request.values.slug = appName.toLowerCase();
				}
			})
			.tapCatch(err => {
				if (!(err instanceof ConflictError)) {
					captureException(err, 'Error in application postparse hook', { req });
				}
			});
	},
});

sbvrUtils.addPureHook('PUT', 'resin', 'application', {
	POSTPARSE: checkDependentApplication,
});

sbvrUtils.addPureHook('PATCH', 'resin', 'application', {
	PRERUN: args => {
		const waitPromises = [checkDependentApplication(args)];
		const { request, api } = args;
		const appName = request.values.app_name;

		if (appName) {
			if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
				throw new BadRequestError('App name may only contain [a-zA-Z0-9_-].');
			}
			if (request.values.slug == null) {
				request.values.slug = appName.toLowerCase();
			}
			waitPromises.push(
				getCurrentRequestAffectedIds(args).then(ids => {
					if (ids.length === 0) {
						return;
					}
					if (ids.length > 1) {
						throw new ConflictError(
							'Cannot rename multiple applications to the same name, please specify just one.',
						);
					}
				}),
			);
		}

		if (request.values.commit != null) {
			// Used to make sure we've fetched the affected ids for the POSTRUN hook
			waitPromises.push(
				getCurrentRequestAffectedIds(args).map(appId =>
					throwErrorIfCommitChangeIsInvalid(api, request.values.commit, appId),
				),
			);
		}

		return Promise.all(waitPromises);
	},
	POSTRUN: args => {
		const { request } = args;
		const waitPromises = [];
		if (request.values.commit != null) {
			// Only update apps if they have had their commit changed.
			waitPromises.push(
				request.custom.affectedIds.then((ids: number[]) => {
					if (ids.length === 0) {
						return;
					}
					postDevices({
						url: '/v1/update',
						req: root,
						filter: {
							belongs_to__application: { $in: ids },
						},
						// Don't wait for the posts to complete, as they may take a long time and we've already sent the prompt to update.
						wait: false,
					});
				}),
			);
		}
		return Promise.all(waitPromises);
	},
});

sbvrUtils.addPureHook('DELETE', 'resin', 'application', {
	PRERUN: args =>
		getCurrentRequestAffectedIds(args).then(appIds => {
			if (appIds.length === 0) {
				const { odataQuery } = args.request;
				if (odataQuery != null && odataQuery.key != null) {
					// If there's a specific app targeted we make sure we give a 404 for backwards compatibility
					throw new Error('Application(s) not found.');
				}
			}
		}),
});

addDeleteHookForDependents('application', [
	['device', 'belongs_to__application'],
	['application_config_variable', 'application'],
	['application_environment_variable', 'application'],
	['application_tag', 'application'],
	['release', 'belongs_to__application'],
	['service', 'application'],
	['application', 'depends_on__application'],
]);
