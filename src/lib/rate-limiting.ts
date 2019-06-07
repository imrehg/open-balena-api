import * as _express from 'express';
import * as redis from 'redis';
import {
	RateLimiterRedis,
	RateLimiterCluster,
	RateLimiterMemory,
	RateLimiterAbstract,
	IRateLimiterOptions,
} from 'rate-limiter-flexible';
import * as Promise from 'bluebird';

import { isMaster } from 'cluster';

import * as _ from 'lodash';
import { captureException } from '../platform/errors';
import {
	RATE_LIMIT_MEMORY_BACKEND,
	REDIS_HOST,
	REDIS_PORT,
	RATE_LIMIT_FACTOR,
} from './config';

const logRedisError = (err: Error) => {
	// do not log these errors, because this would flood our logs
	// when redis is offline
	// these errors are throttle see below
	captureException(err, 'Error: Redis service communication failed ');
};

/*
 Retry to connect to the redis server every 200 ms. To allow recovering
 in case the redis server goes offline and comes online again.
*/
const redisRetryStrategy: redis.RetryStrategy = _.constant(200);

// Use redis as a store.
const getStore = (opts: IRateLimiterOptions) => {
	let insuranceLimiter;
	if (isMaster) {
		insuranceLimiter = new RateLimiterMemory({
			// TODO: points should probably be modifiable for the cluster fallback, ie divide by total instances in prod, RATE_LIMIT_FACTOR???
			...opts,
			keyPrefix: 'myclusterlimiter', // Must be unique for each limiter
		});
	} else {
		insuranceLimiter = new RateLimiterCluster({
			// TODO: points should probably be modifiable for the cluster fallback, ie divide by total instances in prod, RATE_LIMIT_FACTOR???
			...opts,
			keyPrefix: 'myclusterlimiter', // Must be unique for each limiter
			timeoutMs: 3000, // Promise is rejected, if master doesn't answer for 3 secs
			storeClient: undefined,
		});
	}

	if (RATE_LIMIT_MEMORY_BACKEND != null) {
		return insuranceLimiter;
	}

	const client = redis.createClient({
		host: REDIS_HOST,
		port: REDIS_PORT,
		retry_strategy: redisRetryStrategy,
		enable_offline_queue: false,
	});

	// we need to bind to this error handler otherwise a redis error would kill
	// the whole process
	client.on('error', _.throttle(logRedisError, 300000));

	// const opts: ExpressBruteRedisOpts = {
	// 	client,
	// 	prefix: 'api:ratelimiting:',
	// };

	// const redisStore = new ExpressBruteRedis(opts);
	return new RateLimiterRedis({
		...opts,
		storeClient: client,
		// TODO: Fix these args
		inmemoryBlockOnConsumed: 301, // If userId or IP consume >=301 points per minute
		inmemoryBlockDuration: 60, // Block it for a minute in memory, so no requests go to Redis
		insuranceLimiter,
	});
};

export const SECONDS = 1000;
export const SECONDS_PER_HOUR = 60 * 60;
export const MINUTES = 60 * SECONDS;
export const HOURS = 60 * MINUTES;

export const getUserIDFromCreds = Promise.method(
	(req: _express.Request): string => {
		if (req.creds != null && 'id' in req.creds) {
			return `userID:${req.creds.id}`;
		}
		return `nouserID`;
	},
);

export const resetCounter = (req: _express.Request): Promise<void> => {
	return Promise.fromCallback<void>(cb => {
		if (req.brute != null) {
			req.brute.reset(cb);
		} else {
			cb(null);
		}
	}).catch((err: Error) => {
		captureException(err, 'Error failed to reset rate limit counter', { req });
	});
};

export type PartialRateLimitMiddleware = (
	field?: string | ((req: _express.Request, res: _express.Response) => string),
) => _express.RequestHandler;

export const createRateLimitMiddleware = (
	opts: IRateLimiterOptions,
	keyOpts: Parameters<typeof $createRateLimitMiddleware>[1] = {},
): PartialRateLimitMiddleware => {
	if (opts.points != null) {
		opts.points *= RATE_LIMIT_FACTOR;
	}
	const store = getStore(opts);

	return _.partial($createRateLimitMiddleware, store, keyOpts);
};

// If 'field' is set, the middleware will apply the rate limit to requests
// that originate from the same IP *and* have the same 'field'.
//
// If 'field' is not set, the rate limit will be applied to *all* requests
// originating from a particular IP.
const $createRateLimitMiddleware = (
	rateLimiter: RateLimiterAbstract,
	{ ignoreIP = false }: { ignoreIP?: boolean } = {},
	field?: string | ((req: _express.Request, res: _express.Response) => string),
): _express.RequestHandler => {
	let fieldFn: (req: _express.Request, res: _express.Response) => string;
	if (field != null) {
		if (_.isFunction(field)) {
			fieldFn = field;
		} else {
			const path = _.toPath(field);
			fieldFn = req => _.get(req, path);
		}
	} else {
		fieldFn = _.constant('');
	}
	let keyFn: (req: _express.Request, res: _express.Response) => string;
	if (ignoreIP) {
		keyFn = fieldFn;
	} else {
		keyFn = (req, res) => req.ip + '$' + fieldFn(req, res);
	}
	return (req, res, next) => {
		rateLimiter
			.consume(keyFn(req, res))
			.then(() => {
				next();
			})
			.catch(() => {
				res.status(429).send('Too Many Requests');
			});
	};
};
