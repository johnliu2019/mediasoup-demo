#!/usr/bin/env node

'use strict';

process.title = 'mediasoup-server';
process.env.DEBUG = 'mediasoup-server:INFO* mediasoup-server:WARN* mediasoup-server:ERROR*';
// process.env.DEBUG = 'mediasoup-server*';

const webrtcServerVersion = '1.0.0';
const config = require('./config');

/* eslint-disable no-console */
console.log('- process.env.DEBUG:', process.env.DEBUG);
console.log('- config.mediasoup.logLevel:', config.mediasoup.logLevel);
console.log('- config.mediasoup.logTags:', config.mediasoup.logTags);
/* eslint-enable no-console */

const fs = require('fs');
const https = require('https');
const url = require('url');
const protooServer = require('protoo-server');
const mediasoup = require('mediasoup');
const readline = require('readline');
const colors = require('colors/safe');
const repl = require('repl');
const WebSocket = require('ws');
const Logger = require('./lib/Logger');
const Room = require('./lib/Room');
const homer = require('./lib/homer');

const logger = new Logger();
const mcuLogger = new Logger('MCU');

// Map of Room instances indexed by roomId.
const rooms = new Map();

// mcu list
const mcuArray = [];

// meeting session list
const sessionList = {};

// mediasoup server.
const mediaServer = mediasoup.Server(
	{
		numWorkers       : null, // Use as many CPUs as available.
		logLevel         : config.mediasoup.logLevel,
		logTags          : config.mediasoup.logTags,
		rtcIPv4          : config.mediasoup.rtcIPv4,
		rtcIPv6          : config.mediasoup.rtcIPv6,
		rtcAnnouncedIPv4 : config.mediasoup.rtcAnnouncedIPv4,
		rtcAnnouncedIPv6 : config.mediasoup.rtcAnnouncedIPv6,
		rtcMinPort       : config.mediasoup.rtcMinPort,
		rtcMaxPort       : config.mediasoup.rtcMaxPort
	});

// Do Homer stuff.
if (process.env.MEDIASOUP_HOMER_OUTPUT)
	homer(mediaServer);

global.SERVER = mediaServer;

mediaServer.on('newroom', (room) =>
{
	global.ROOM = room;

	room.on('newpeer', (peer) =>
	{
		global.PEER = peer;

		if (peer.consumers.length > 0)
			global.CONSUMER = peer.consumers[peer.consumers.length - 1];

		peer.on('newtransport', (transport) =>
		{
			global.TRANSPORT = transport;
		});

		peer.on('newproducer', (producer) =>
		{
			global.PRODUCER = producer;
		});

		peer.on('newconsumer', (consumer) =>
		{
			global.CONSUMER = consumer;
		});
	});
});

// HTTPS server for the protoo WebSocket server.
const tls =
{
	cert : fs.readFileSync(config.tls.cert),
	key  : fs.readFileSync(config.tls.key)
};

const httpsServer = https.createServer(tls, (req, res) =>
{
	res.writeHead(404, 'Not Here');
	res.end();
});

httpsServer.listen(config.mediasoup.signalServerPort, '0.0.0.0', () =>
{
	logger.info('webrtc server %s running at port %d', webrtcServerVersion, config.mediasoup.signalServerPort);
});

// Protoo WebSocket server.
const webSocketServer = new protooServer.WebSocketServer(httpsServer,
	{
		maxReceivedFrameSize     : 960000, // 960 KBytes.
		maxReceivedMessageSize   : 960000,
		fragmentOutgoingMessages : true,
		fragmentationThreshold   : 960000
	});

// Handle connections from clients.
webSocketServer.on('connectionrequest', (info, accept, reject) =>
{
	// The client indicates the roomId and peerId in the URL query.
	const u = url.parse(info.request.url, true);
	const roomId = u.query['roomId'];
	const peerName = u.query['peerName'];
	const hash = u.query['hash'];

	if (!roomId || !peerName)
	{
		logger.warn('connection request without roomId and/or peerName');

		reject(400, 'Connection request without roomId and/or peerName');

		return;
	}

	if(!hash) {
		logger.warn(
			'connection request [roomId:"%s", peerName:"%s"] has no hash', roomId, peerName);

		reject(400, 'Connection request without hash');

		return;
	}

	// check whether the session is active at mcu
	const mysession = sessionList[roomId];
	if(!mysession) {
		logger.warn(
			'connection request [roomId:"%s", peerName:"%s"] no session info found', roomId, peerName);

		reject(400, 'Connection request no session info found');

		return;
	}
	const mcuIndex = mysession.mcuIndex;
	const sessionInfo = mysession.bandwidth || 0;

	// check the auth
	if(!mysession[peerName]) {
		logger.warn(
			'connection request [mcuIndex:%d, roomId:"%s", peerName:"%s"] no auth info found', mcuIndex, roomId, peerName);

		reject(400, 'Connection request no auth info found');

		return;
	}
	const auth = mysession[peerName].value1;
	if(auth != hash) {
		logger.warn(
			'connection request [mcuIndex:%d, roomId:"%s", peerName:"%s"] auth info not match', mcuIndex, roomId, peerName);

		reject(400, 'Connection request auth info not match');

		return;
	}

	let auth2;
		
	auth2 = mysession[peerName].value2;
	auth2 = auth2 || '';

	let room;

	// If an unknown roomId, create a new Room.
	if (!rooms.has(roomId))
	{
		logger.debug('creating a new Room [mcuIndex:%d, roomId:"%s", peerName:"%s"]', mcuIndex, roomId, peerName);

		try
		{
			room = new Room(roomId, mediaServer);

			room.mcuIndex = mcuIndex;

			global.APP_ROOM = room;
			if(sessionInfo) {
				room._bandwidth = sessionInfo;
				logger.info(
					'new Room [mcuIndex:%d, roomId:"%s"] created upon connection from [peerName:"%s"] uses bandwidth of %d',
					mcuIndex, roomId, peerName, sessionInfo);
			}
		}
		catch (error)
		{
			logger.error('error creating a new Room [mcuIndex:%d, roomId:"%s", peerName:"%s"]: %s',
				mcuIndex, roomId, peerName, error);

			reject(error);

			return;
		}

		const logStatusTimer = setInterval(() =>
		{
			room.logStatus();
		}, 30000);

		rooms.set(roomId, room);

		room.on('close', () =>
		{
			rooms.delete(roomId);
			clearInterval(logStatusTimer);
		});
	}
	else
	{
		room = rooms.get(roomId);
	}

	const transport = accept();

	room.handleConnection(peerName, transport, auth2);

	let peerNo1;
	try {
		peerNo1 = room._protooRoom.peers.length;
	} catch(e) { 
		peerNo1 = 'unknown';
	}
	logger.info(
		'[mcuIndex:%d, roomId:"%s", peerName:"%s"] joins the room[total: %s]',
		mcuIndex, roomId, peerName, peerNo1);
});

// connect to MCU
function array2str(data) {
	let text;
	try {
		text = String.fromCharCode.apply(null, data);
	} catch(e) {
		text = '';
		let i;
		for(i = 0; i < data.length; i++) {
			text += String.fromCharCode(data[i]);
		}
	}

	return text;
}

function clearMcuSession(mcuIndex) {
	const thisMcu = mcuArray[mcuIndex];
	const mcu = thisMcu.mcu;
	for(const key in sessionList) {
		if(Object.prototype.hasOwnProperty.call(sessionList, key)) {
			const mysession = sessionList[key];
			if(mysession.mcuIndex == mcuIndex) {
				delete sessionList[key];
				mcuLogger.info('[%d]%s, clear session %s', mcuIndex, mcu, key);
			}
		}
	}
}

function delayedConnectMCU(mcuIndex) {
	const thisMcu = mcuArray[mcuIndex];
	if(thisMcu.retryCount < 10) {
		thisMcu.retryCount++;
	}

	let delay = 1 << thisMcu.retryCount;
	if(delay > 60) {
		delay = 60;
	}

	setTimeout(() => {
		connectMCU(mcuIndex);
	}, delay * 1000);
}

function connectMCU(mcuIndex) {
	const thisMcu = mcuArray[mcuIndex];
	const mcu = thisMcu.mcu;

	const ws = new WebSocket(mcu, 'hmtg');
	const timeoutThreshold = 9 * 1000;
	let timeoutID = null;

	mcuLogger.info('connecting to [%d]%s', mcuIndex, mcu);

	ws.binaryType = 'arraybuffer';
	function turnOnTimer() {
		turnOffTimer();
		timeoutID = setTimeout(function() {
			timeoutID = null;
			mcuLogger.info('[%d]%s, connection timeout', mcuIndex, mcu);
			ws.onclose = ws.onerror = null;
			ws.terminate();
			clearMcuSession(mcuIndex);
			delayedConnectMCU(mcuIndex);
		}, timeoutThreshold);
	}

	function turnOffTimer() {
		if(timeoutID != null) {
			clearTimeout(timeoutID);
			timeoutID = null;
		}
	}

	ws.onopen = function(evt) {
		thisMcu.retryCount = 0;
		mcuLogger.info('connected with [%d]%s', mcuIndex, mcu);
		turnOnTimer();
	};

	ws.onclose = function(evt) {
		mcuLogger.info('[%d]%s, connection is closed', mcuIndex, mcu);
		ws.onerror = null;
		ws.terminate();
		turnOffTimer();
		clearMcuSession(mcuIndex);
		delayedConnectMCU(mcuIndex);
	};
	ws.onerror = function(evt) {
		mcuLogger.info('[%d]%s, connection is broken', mcuIndex, mcu);
		ws.onclose = null;
		ws.terminate();
		turnOffTimer();
		clearMcuSession(mcuIndex);
		delayedConnectMCU(mcuIndex);
	};
	ws.onmessage = function(evt) {
		let object;
		let raw;

		try {
			raw = array2str(new Uint8Array(evt.data));

			object = JSON.parse(raw);
		}
		catch(error) {
			mcuLogger.error('[%d]%s parse error(%s) | invalid JSON: %s', mcuIndex, mcu, raw, error);

			return;
		}

		if(typeof object !== 'object' || Array.isArray(object)) {
			mcuLogger.error('[%d]%s parse error(%s) | not an object', mcuIndex, mcu, raw);

			return;
		}

		if(typeof object.type !== 'string') {
			mcuLogger.error('[%d]%s parse error(%s) | type is not string', mcuIndex, mcu, raw);

			return;
		}

		turnOnTimer();

		if(object.type == 'idle') {
			return;
		}

		if(object.type == 'error') {
			let errorText = '';

			if(typeof object.text === 'string') {
				errorText = object.text;
			}

			mcuLogger.info('[%d]%s encounter error %s, abort', mcuIndex, mcu, errorText);
			ws.onclose = ws.onerror = null;
			ws.terminate();
			turnOffTimer();

			return;
		}

		if(object.type == 'session1') {
			if(typeof object.session === 'string'
				&& typeof object.bandwidth === 'number'
				&& object.session) {

				const session = sessionList[object.session] || {};
				sessionList[object.session] = session;

				session.mcuIndex = mcuIndex;
				session.bandwidth = object.bandwidth;

				mcuLogger.info('[%d]%s, add session %s, bandwidth %d', mcuIndex, mcu, object.session, object.bandwidth);

				return;
			}
		}

		if(object.type == 'session2') {
			if(typeof object.session === 'string' && object.session) {
				if(sessionList[object.session]) {
					delete sessionList[object.session];

					mcuLogger.info('[%d]%s, delete session %s', mcuIndex, mcu, object.session);
				}

				return;
			}
		}

		if(object.type == 'auth') {
			if(typeof object.session === 'string'
				&& typeof object.ssrc === 'number'
				&& typeof object.value1 === 'string'
				&& typeof object.value2 === 'string'
				&& object.session
				&& object.value1
				&& object.value2) {
				if(sessionList[object.session]) {

					const session = sessionList[object.session];

					session[object.ssrc] = { value1: object.value1, value2: object.value2 };

					mcuLogger.info('[%d]%s, add user, session=%s, ssrc=%d', mcuIndex, mcu, object.session, object.ssrc);
				}

				return;
			}
		}

		mcuLogger.info('unknown or invalid data from [%d]%s: %s', mcuIndex, mcu, raw);
	};
}

let i;
for(i = 0; i < config.mediasoup.mcu.length; i++) {
	const thisMcu = {};
	mcuArray.push(thisMcu);

	thisMcu.mcu = config.mediasoup.mcu[i];
	thisMcu.retryCount = 0;
	thisMcu.mcuIndex = i;

	connectMCU(i);
}

// Listen for keyboard input.

let cmd;
let terminal;

openCommandConsole();

function openCommandConsole()
{
	stdinLog('[opening Readline Command Console...]');

	closeCommandConsole();
	closeTerminal();

	cmd = readline.createInterface(
		{
			input  : process.stdin,
			output : process.stdout
		});

	cmd.on('SIGINT', () =>
	{
		process.exit();
	});

	readStdin();

	function readStdin()
	{
		cmd.question('cmd> ', (answer) =>
		{
			switch (answer)
			{
				case '':
				{
					readStdin();
					break;
				}

				case 'h':
				case 'help':
				{
					stdinLog('');
					stdinLog('available commands:');
					stdinLog('- h,  help          : show this message');
					stdinLog('- sd, serverdump    : execute server.dump()');
					stdinLog('- rd, roomdump      : execute room.dump() for the latest created mediasoup Room');
					stdinLog('- pd, peerdump      : execute peer.dump() for the latest created mediasoup Peer');
					stdinLog('- td, transportdump : execute transport.dump() for the latest created mediasoup Transport');
					stdinLog('- prd, producerdump : execute producer.dump() for the latest created mediasoup Producer');
					stdinLog('- cd, consumerdump : execute consumer.dump() for the latest created mediasoup Consumer');
					stdinLog('- t,  terminal      : open REPL Terminal');
					stdinLog('');
					readStdin();

					break;
				}

				case 'sd':
				case 'serverdump':
				{
					mediaServer.dump()
						.then((data) =>
						{
							stdinLog(`server.dump() succeeded:\n${JSON.stringify(data, null, '  ')}`);
							readStdin();
						})
						.catch((error) =>
						{
							stdinError(`mediaServer.dump() failed: ${error}`);
							readStdin();
						});

					break;
				}

				case 'rd':
				case 'roomdump':
				{
					if (!global.ROOM)
					{
						readStdin();
						break;
					}

					global.ROOM.dump()
						.then((data) =>
						{
							stdinLog(`room.dump() succeeded:\n${JSON.stringify(data, null, '  ')}`);
							readStdin();
						})
						.catch((error) =>
						{
							stdinError(`room.dump() failed: ${error}`);
							readStdin();
						});

					break;
				}

				case 'pd':
				case 'peerdump':
				{
					if (!global.PEER)
					{
						readStdin();
						break;
					}

					global.PEER.dump()
						.then((data) =>
						{
							stdinLog(`peer.dump() succeeded:\n${JSON.stringify(data, null, '  ')}`);
							readStdin();
						})
						.catch((error) =>
						{
							stdinError(`peer.dump() failed: ${error}`);
							readStdin();
						});

					break;
				}

				case 'td':
				case 'transportdump':
				{
					if (!global.TRANSPORT)
					{
						readStdin();
						break;
					}

					global.TRANSPORT.dump()
						.then((data) =>
						{
							stdinLog(`transport.dump() succeeded:\n${JSON.stringify(data, null, '  ')}`);
							readStdin();
						})
						.catch((error) =>
						{
							stdinError(`transport.dump() failed: ${error}`);
							readStdin();
						});

					break;
				}

				case 'prd':
				case 'producerdump':
				{
					if (!global.PRODUCER)
					{
						readStdin();
						break;
					}

					global.PRODUCER.dump()
						.then((data) =>
						{
							stdinLog(`producer.dump() succeeded:\n${JSON.stringify(data, null, '  ')}`);
							readStdin();
						})
						.catch((error) =>
						{
							stdinError(`producer.dump() failed: ${error}`);
							readStdin();
						});

					break;
				}

				case 'cd':
				case 'consumerdump':
				{
					if (!global.CONSUMER)
					{
						readStdin();
						break;
					}

					global.CONSUMER.dump()
						.then((data) =>
						{
							stdinLog(`consumer.dump() succeeded:\n${JSON.stringify(data, null, '  ')}`);
							readStdin();
						})
						.catch((error) =>
						{
							stdinError(`consumer.dump() failed: ${error}`);
							readStdin();
						});

					break;
				}

				case 't':
				case 'terminal':
				{
					openTerminal();

					break;
				}

				default:
				{
					stdinError(`unknown command: ${answer}`);
					stdinLog('press \'h\' or \'help\' to get the list of available commands');

					readStdin();
				}
			}
		});
	}
}

function openTerminal()
{
	stdinLog('[opening REPL Terminal...]');

	closeCommandConsole();
	closeTerminal();

	terminal = repl.start(
		{
			prompt          : 'terminal> ',
			useColors       : true,
			useGlobal       : true,
			ignoreUndefined : false
		});

	terminal.on('exit', () => openCommandConsole());
}

function closeCommandConsole()
{
	if (cmd)
	{
		cmd.close();
		cmd = undefined;
	}
}

function closeTerminal()
{
	if (terminal)
	{
		terminal.removeAllListeners('exit');
		terminal.close();
		terminal = undefined;
	}
}

function stdinLog(msg)
{
	// eslint-disable-next-line no-console
	console.log(colors.green(msg));
}

function stdinError(msg)
{
	// eslint-disable-next-line no-console
	console.error(colors.red.bold('ERROR: ') + colors.red(msg));
}
