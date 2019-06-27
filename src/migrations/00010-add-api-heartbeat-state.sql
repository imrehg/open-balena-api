-- Simple integer to hold the state of the API heartbeat
-- values: 1 = online, 0 = offline, -1 = timeout, -2 = unknown
-- default: -2

ALTER TABLE "device" ADD COLUMN "api heartbeat state" integer NOT NULL DEFAULT -2;

