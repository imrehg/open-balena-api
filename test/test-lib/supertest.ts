import * as _ from 'lodash';
import * as supertest from 'supertest';
import * as express from 'express';
import { User } from '../../src/platform/jwt';

type UserObjectParam = Partial<User & { token: string }>;

export = function(app: express.Express, user?: string | UserObjectParam) {
	// Can be an object with `token`, a JWT string or an API key string
	let token = user;
	if (typeof user === 'object' && user.token) {
		token = user.token;
	}
	// We have to cast `as any` because the types are poorly maintained
	// and don't support setting defaults
	const req: any = supertest.agent(app);
	req.set('X-Forwarded-Proto', 'https');

	if (_.isString(token)) {
		req.set('Authorization', `Bearer ${token}`);
	}
	return req as ReturnType<typeof supertest.agent>;
};
