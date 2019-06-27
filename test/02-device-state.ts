import 'mocha';
import { app } from '../init';
import supertest = require('./test-lib/supertest');
import fixturesLib = require('./test-lib/fixtures');
import { expect } from 'chai';

import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as sinon from 'sinon';
import mockery = require('mockery');
import node_uuid = require('node-uuid');
import randomstring = require('randomstring');

import stateMock = require('../src/lib/device-online-state');
import configMock = require('../src/lib/config');
import envMock = require('../src/lib/env-vars');

async function createDeviceForApplication(
	model: { uuid: string; deviceApiKey: string },
	applicationId: number,
	user: AnyObject,
) {
	// create a provisioning key...
	const { body: provisioningKey } = await supertest(app, user)
		.post(`/api-key/application/${applicationId}/provisioning`)
		.expect(200);

	expect(provisioningKey).to.be.a('string');

	// use the provisioning key to register a new device...
	const { body: deviceRegistration } = await supertest(app)
		.post(`/device/register?apikey=${provisioningKey}`)
		.send({
			user: user.id,
			application: applicationId,
			device_type: 'raspberry-pi',
			device_name: 'test-name',
			uuid: model.uuid,
			api_key: model.deviceApiKey,
		})
		.expect(201);

	expect(deviceRegistration)
		.to.have.property('id')
		.that.is.a('number');
	expect(deviceRegistration)
		.to.have.property('uuid')
		.that.equals(model.uuid);
	expect(deviceRegistration)
		.to.have.property('api_key')
		.that.equals(model.deviceApiKey);

	//get the full device model...
	const { body: results } = await supertest(app, user)
		.get(`/resin/device(${deviceRegistration.id})`)
		.expect(200);

	expect(results)
		.to.have.nested.property('d[0]')
		.that.is.an('object');

	// return the device...
	return results.d[0];
}

async function createReleaseInApplication(
	commit = 'deadbeef',
	appId: number,
	user: AnyObject,
) {
	const { body: release } = await supertest(app, user)
		.post(`/resin/release`)
		.send({
			belongs_to__application: appId,
			is_created_by__user: user.id,
			commit,
			status: 'success',
			source: 'tests',
			start_timestamp: Date.now(),
			end_timestamp: Date.now(),
			composition: {},
		})
		.expect(201);

	expect(release)
		.to.have.property('id')
		.that.is.a('number');

	return release;
}

const POLL_SEC = 5;
const TIMEOUT_SEC = 2;

describe('API Heartbeat State', () => {
	let uuid = '';

	let loadedFixtures: fixturesLib.FixtureData;
	let user = {} as AnyObject;
	let app1 = {} as AnyObject;
	let device1 = {} as AnyObject;
	let device1Key = '';

	let stateUpdateSpy = sinon.spy();

	before(async () => {
		mockery.enable({
			warnOnReplace: true,
			warnOnUnregistered: false,
		});

		// mock the value for the default poll interval...
		(envMock as AnyObject)['DEFAULT_SUPERVISOR_POLL_INTERVAL'] =
			POLL_SEC * 1000;
		mockery.registerMock('../src/lib/env-vars', envMock);

		// mock the value for the timeout grace period...
		(configMock as AnyObject)[
			'API_HEARTBEAT_STATE_TIMEOUT_SECONDS'
		] = TIMEOUT_SEC;
		mockery.registerMock('../src/lib/config', configMock);

		// mock the device state lib to hook the update of Pine models...
		const updateDeviceModel: Function = (stateMock.manager as AnyObject)[
			'updateDeviceModel'
		];
		(stateMock.manager as AnyObject)['updateDeviceModel'] = (
			uuid: string,
			newState: stateMock.DeviceOnlineStates,
		) => {
			stateUpdateSpy(uuid, newState);
			console.log(
				`Device update: ${uuid} is now ${stateMock.DeviceOnlineStates[newState]}`,
			);
			return updateDeviceModel(uuid, newState);
		};
		// mock the return for determining a device poll interval...
		(stateMock as AnyObject)['getPollIntervalForDevice'] = () =>
			Bluebird.resolve(POLL_SEC * 1000);

		// register the device state mock...
		mockery.registerMock('../src/lib/device-online-state', stateMock);

		// load some fixtures...
		uuid = node_uuid.v4().replace(/\-/g, '');

		loadedFixtures = await fixturesLib.load('device-state-basic');

		user = loadedFixtures.users.root;
		app1 = loadedFixtures.applications.app1;
		device1Key = randomstring.generate();

		device1 = await createDeviceForApplication(
			{ uuid, deviceApiKey: device1Key },
			app1.id,
			user,
		);

		await createReleaseInApplication('deadbeef', app1.id, user);

		const { body: apps } = await supertest(app, user)
			.get(`/resin/application(${app1.id})`)
			.expect(200);

		expect(apps)
			.to.have.nested.property('d[0]')
			.that.is.an('object');
		expect(apps.d).to.have.lengthOf(1);

		app1 = apps.d[0];
	});

	after(() => {
		mockery.disable();
		return fixturesLib.clean(loadedFixtures);
	});

	enum HeartbeatState {
		ONLINE = 1,
		OFFLINE = 0,
		TIMEOUT = -1,
		UNKNOWN = -2,
	}

	it('Should have the device in an UNKNOWN state', async () => {
		const { body: devices } = await supertest(app, user)
			.get(`/resin/device(${device1.id})`)
			.expect(200);

		expect(devices.d).to.have.lengthOf(1);

		const device = devices.d[0];

		// by default, the device will be in the unknown state...
		expect(device)
			.to.have.property('api_heartbeat_state')
			.that.equals(HeartbeatState.UNKNOWN);
	});

	it('Should change to ONLINE after GET /device/v2/:uuid/state', async () => {
		// poll the state endpoint, triggering an online event...
		await supertest(app, device1Key)
			.get(`/device/v2/${uuid}/state`)
			.expect(200);
		await Bluebird.delay(1000); // allow a second to let the state settle...

		// check the model was only updated once...
		expect(stateUpdateSpy.callCount).is.equal(
			1,
			'Calls to update the device model',
		);
		expect(
			stateUpdateSpy.calledOnceWithExactly(
				uuid,
				stateMock.DeviceOnlineStates.Online,
			),
		).is.true;

		// reset our spy to be checked later...
		stateUpdateSpy.resetHistory();

		// get the device record to see that it is now online...
		const { body: devices } = await supertest(app, user)
			.get(`/resin/device(${device1.id})`)
			.expect(200);

		expect(devices.d).to.have.lengthOf(1);
		const device = devices.d[0];

		// it should be marked online...
		expect(device)
			.to.have.property('api_heartbeat_state')
			.that.equals(HeartbeatState.ONLINE);
	});

	it('Should stay as ONLINE as long as we GET /device/v2/:uuid/state within the poll interval', async () => {
		const pollStateInterval = (POLL_SEC / 3) * 2 * 1000;
		const pollStateEndpoint = () =>
			supertest(app, device1Key)
				.get(`/device/v2/${uuid}/state`)
				.expect(200);

		for (let i = 0; i < 3; i++) {
			await Bluebird.delay(pollStateInterval);
			await pollStateEndpoint();
		}

		expect(stateUpdateSpy.callCount).is.equal(
			0,
			'Do not update the device model as long as it stays online and keeps polling',
		);

		const { body: devices } = await supertest(app, user)
			.get(`/resin/device(${device1.id})`)
			.expect(200);

		expect(devices.d).to.have.lengthOf(1);
		const device = devices.d[0];

		// it should be marked online...
		expect(device)
			.to.have.property('api_heartbeat_state')
			.that.equals(HeartbeatState.ONLINE);
	});

	it('Should change to TIMEOUT after the poll interval elapses', async () => {
		// wait for the device to do a poll timeout...
		await Bluebird.delay(POLL_SEC * 1000 + 1000);

		// we should have had a single call...
		expect(stateUpdateSpy.callCount).is.equal(1);
		expect(
			stateUpdateSpy.calledOnceWithExactly(
				uuid,
				stateMock.DeviceOnlineStates.Timeout,
			),
		).is.true;
		stateUpdateSpy.resetHistory();

		// get the device record again...
		const { body: devices } = await supertest(app, user)
			.get(`/resin/device(${device1.id})`)
			.expect(200);

		expect(devices.d).to.have.lengthOf(1);
		const device = devices.d[0];

		// it should be marked timeout...
		expect(device)
			.to.have.property('api_heartbeat_state')
			.that.equals(HeartbeatState.TIMEOUT);
	});

	it('Should change to OFFLINE after the timeout interval elapses', async () => {
		// wait for the device to do a timeout completely...
		await Bluebird.delay(TIMEOUT_SEC * 1000 + 1000);

		// we should have had a single call...
		expect(stateUpdateSpy.callCount).is.equal(1);
		expect(
			stateUpdateSpy.calledOnceWithExactly(
				uuid,
				stateMock.DeviceOnlineStates.Offline,
			),
		).is.true;
		stateUpdateSpy.resetHistory();

		// get the device record again...
		const { body: devices } = await supertest(app, user)
			.get(`/resin/device(${device1.id})`)
			.expect(200);

		expect(devices.d).to.have.lengthOf(1);
		const device = devices.d[0];

		// it should be marked offline...
		expect(device)
			.to.have.property('api_heartbeat_state')
			.that.equals(HeartbeatState.OFFLINE);
	});
});
