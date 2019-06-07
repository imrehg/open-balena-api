const numWorkers = process.env.NUM_WORKERS || require('os').cpus().length;
if (numWorkers > 1) {
	const cluster = require('cluster');
	if (cluster.isMaster) {
		// Setup the RateLimiterCluster store on the master worker
		const { RateLimiterCluster } = require('rate-limiter-flexible');
		new RateLimiterCluster();

		console.log(`Forking ${numWorkers} workers`);
		for (let i = 0; i < numWorkers; i++) {
			console.log(`Forking worker ${i}`);
			cluster.fork(process.env);
		}

		cluster.on('exit', worker => {
			console.log('Worker ' + worker.id + ' died, replacing it');
			cluster.fork(process.env);
		});
		return;
	}
}

// Use fast-boot to cache require lookups, speeding up startup
require('fast-boot2').start({
	cacheFile: '.fast-boot.json',
});

// Support `require()` of *.ts files
process.env.TS_NODE_CACHE_DIRECTORY = '.ts-node';
require('ts-node/register/transpile-only');

require('./init.ts');
