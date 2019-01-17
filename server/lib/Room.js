'use strict';

const EventEmitter = require('events').EventEmitter;
const protooServer = require('protoo-server');
const Logger = require('./Logger');
const config = require('../config');

const MAX_BITRATE = config.mediasoup.maxBitrate || 1500000;
const DEFAULT_BITRATE = config.mediasoup.defaultBitrate || 500000;
const MIN_BITRATE = 20000;

const logger = new Logger('Room');

class Room extends EventEmitter
{
	constructor(roomId, mediaServer)
	{
		logger.debug('constructor() [roomId:"%s"]', roomId);

		super();
		this.setMaxListeners(Infinity);

		// Room ID.
		this._roomId = roomId;

		// Closed flag.
		this._closed = false;

		// bandwidth
		this._bandwidth = DEFAULT_BITRATE;

		try
		{
			// Protoo Room instance.
			this._protooRoom = new protooServer.Room();

			// mediasoup Room instance.
			this._mediaRoom = mediaServer.Room(config.mediasoup.mediaCodecs);
		}
		catch (error)
		{
			this.close();

			throw error;
		}

		// Current active speaker.
		// @type {mediasoup.Peer}
		this._currentActiveSpeaker = null;

		this._handleMediaRoom();
	}

	get id()
	{
		return this._roomId;
	}

	close()
	{
		logger.debug('close() [roomId:"%s"]', this._roomId);

		this._closed = true;

		// Close the protoo Room.
		if (this._protooRoom)
			this._protooRoom.close();

		// Close the mediasoup Room.
		if (this._mediaRoom)
			this._mediaRoom.close();

		// Emit 'close' event.
		this.emit('close');
	}

	logStatus()
	{
		if (!this._mediaRoom)
			return;

		logger.debug(
			'logStatus() [room id:"%s", protoo peers:%s, mediasoup peers:%s]',
			this._roomId,
			this._protooRoom.peers.length,
			this._mediaRoom.peers.length);
	}

	handleConnection(peerName, transport, auth2)
	{
		logger.debug('handleConnection() [peerName:"%s"]', peerName);

		if (this._protooRoom.hasPeer(peerName))
		{
			logger.warn(
				'handleConnection() | there is already a peer with same peerName, ' +
				'closing the previous one [mcuIndex:%d, roomId:"%s", peerName:"%s"]',
				this.mcuIndex, this._roomId, peerName);

			const protooPeer = this._protooRoom.getPeer(peerName);

			protooPeer.close();
		}

		const protooPeer = this._protooRoom.createPeer(peerName, transport);

		// assume joinnet max bitrate is MAX: 10000000
		protooPeer.maxJoinnetBitrate = 10000000;

		// send auth info to the client
		protooPeer.send('auth', { 'hash': auth2 })
			.catch(() => { 
				logger.error(
					'connection [mcuIndex:%d, roomId:"%s", peerName:"%s"] is rejected due to mismatch auth',
					this.mcuIndex, this._roomId, peerName);
			});
		
		this._handleProtooPeer(protooPeer);
	}

	_handleMediaRoom()
	{
		logger.debug('_handleMediaRoom()');

		const activeSpeakerDetector = this._mediaRoom.createActiveSpeakerDetector();

		activeSpeakerDetector.on('activespeakerchange', (activePeer) =>
		{
			if (activePeer)
			{
				logger.debug('new active speaker [peerName:"%s"]', activePeer.name);

				this._currentActiveSpeaker = activePeer;

				const activeVideoProducer = activePeer.producers
					.find((producer) => producer.kind === 'video');

				for (const peer of this._mediaRoom.peers)
				{
					for (const consumer of peer.consumers)
					{
						if (consumer.kind !== 'video')
							continue;

						if (consumer.source === activeVideoProducer)
						{
							consumer.setPreferredProfile('high');
						}
						else
						{
							consumer.setPreferredProfile('low');
						}
					}
				}
			}
			else
			{
				logger.debug('no active speaker');

				this._currentActiveSpeaker = null;

				for (const peer of this._mediaRoom.peers)
				{
					for (const consumer of peer.consumers)
					{
						if (consumer.kind !== 'video')
							continue;

						consumer.setPreferredProfile('low');
					}
				}
			}

			// Spread to others via protoo.
			this._protooRoom.spread(
				'active-speaker',
				{
					peerName : activePeer ? activePeer.name : null
				});
		});
	}

	_handleProtooPeer(protooPeer)
	{
		logger.debug('_handleProtooPeer() [peer:"%s"]', protooPeer.id);

		protooPeer.on('request', (request, accept, reject) =>
		{
			logger.debug(
				'protoo "request" event [method:%s, peer:"%s"]',
				request.method, protooPeer.id);

			switch (request.method)
			{
				case 'mediasoup-request':
				{
					const mediasoupRequest = request.data;

					this._handleMediasoupClientRequest(
						protooPeer, mediasoupRequest, accept, reject);

					break;
				}

				case 'mediasoup-notification':
				{
					accept();

					const mediasoupNotification = request.data;

					this._handleMediasoupClientNotification(
						protooPeer, mediasoupNotification);

					break;
				}

				case 'change-display-name':
				{
					accept();

					const { displayName } = request.data;
					const { mediaPeer } = protooPeer.data;
					const oldDisplayName = mediaPeer.appData.displayName;

					mediaPeer.appData.displayName = displayName;

					// Spread to others via protoo.
					this._protooRoom.spread(
						'display-name-changed',
						{
							peerName       : protooPeer.id,
							displayName    : displayName,
							oldDisplayName : oldDisplayName
						},
						[ protooPeer ]);

					break;
				}

				case 'change-consumer-preferred-profile':
				{
					const { consumerId, profile } = request.data;
					const { mediaPeer } = protooPeer.data;
					const consumer = mediaPeer.consumers
						.find((_consumer) => _consumer.id === consumerId);

					if (!consumer)
					{
						logger.warn('consumer with id "%s" not found', consumerId);

						reject(404, 'consumer not found');

						return;
					}

					consumer.setPreferredProfile(profile);

					accept();

					break;
				}

				case 'request-consumer-keyframe':
				{
					const { consumerId } = request.data;
					const { mediaPeer } = protooPeer.data;
					const consumer = mediaPeer.consumers
						.find((_consumer) => _consumer.id === consumerId);

					if (!consumer)
					{
						logger.warn('consumer with id "%s" not found', consumerId);

						reject(404, 'consumer not found');

						return;
					}

					consumer.requestKeyFrame();

					accept();

					break;
				}

				case 'change-bitrate':
				{
					accept();

					const { bitrate } = request.data;
					protooPeer.maxJoinnetBitrate = bitrate;
					logger.debug('protoo Peer [mcuIndex:%d, roomId:"%s", peer:"%s"] joinnet change max bitrate to %s',
						this.mcuIndex, this._roomId, protooPeer.id, bitrate);
						
					const { mediaPeer } = protooPeer.data;
					if(mediaPeer) {
						const { transports } = mediaPeer;
						if(transports) {
							for(const transport of transports) {
								if(transport.direction === 'send') {
									this._updateMaxBitrate(transport, protooPeer);
								}
							}
						}
					}

					break;
				}
				
				default:
				{
					logger.error('unknown request.method "%s" [mcuIndex:%d, roomId:"%s", peerName:"%s"]',
						request.method, this.mcuIndex, this._roomId, protooPeer.id);

					reject(400, `unknown request.method "${request.method}"`);
				}
			}
		});

		protooPeer.on('close', () =>
		{
			logger.info('protoo Peer "close" event [mcuIndex:%d, roomId:"%s", peer:"%s"]',
				this.mcuIndex, this._roomId, protooPeer.id);

			const { mediaPeer } = protooPeer.data;

			if (mediaPeer && !mediaPeer.closed)
				mediaPeer.close();

			// If this is the latest peer in the room, close the room.
			// However wait a bit (for reconnections).
			setTimeout(() =>
			{
				if (this._mediaRoom && this._mediaRoom.closed)
					return;

				if (this._mediaRoom.peers.length === 0)
				{
					logger.info(
						'last peer in the room left, closing the room [mcuIndex:%d, roomId:"%s"]',
						this.mcuIndex, this._roomId);

					this.close();
				}
			}, 5000);
		});
	}

	_handleMediaPeer(protooPeer, mediaPeer)
	{
		mediaPeer.on('notify', (notification) =>
		{
			protooPeer.send('mediasoup-notification', notification)
				.catch(() => {});
		});

		mediaPeer.on('newtransport', (transport) =>
		{
			logger.debug(
				'mediaPeer "newtransport" event [peer.name:%s, transport.id:%s, direction:%s]',
				mediaPeer.name, transport.id, transport.direction);

			// Update peers max sending  bitrate.
			if (transport.direction === 'send')
			{
				// reset the old max bitrate to 0
				transport.oldMaxBitrate = 0;
				this._updateMaxBitrate(transport, protooPeer);
			}

			this._handleMediaTransport(transport);
		});

		mediaPeer.on('newproducer', (producer) =>
		{
			logger.debug('mediaPeer "newproducer" event [id:%s]', producer.id);

			this._handleMediaProducer(producer);
		});

		mediaPeer.on('newconsumer', (consumer) =>
		{
			logger.debug('mediaPeer "newconsumer" event [id:%s]', consumer.id);

			this._handleMediaConsumer(consumer);
		});

		// Also handle already existing Consumers.
		for (const consumer of mediaPeer.consumers)
		{
			logger.debug('mediaPeer existing "consumer" [id:%s]', consumer.id);

			this._handleMediaConsumer(consumer);
		}

		// Notify about the existing active speaker.
		if (this._currentActiveSpeaker)
		{
			protooPeer.send(
				'active-speaker',
				{
					peerName : this._currentActiveSpeaker.name
				})
				.catch(() => {});
		}
	}

	_handleMediaTransport(transport)
	{
		transport.on('close', (originator) =>
		{
			logger.debug(
				'Transport "close" event [originator:%s]', originator);
		});
	}

	_handleMediaProducer(producer)
	{
		producer.on('close', (originator) =>
		{
			logger.debug(
				'Producer "close" event [originator:%s]', originator);
		});

		producer.on('pause', (originator) =>
		{
			logger.debug(
				'Producer "pause" event [originator:%s]', originator);
		});

		producer.on('resume', (originator) =>
		{
			logger.debug(
				'Producer "resume" event [originator:%s]', originator);
		});
	}

	_handleMediaConsumer(consumer)
	{
		consumer.on('close', (originator) =>
		{
			logger.debug(
				'Consumer "close" event [originator:%s]', originator);
		});

		consumer.on('pause', (originator) =>
		{
			logger.debug(
				'Consumer "pause" event [originator:%s]', originator);
		});

		consumer.on('resume', (originator) =>
		{
			logger.debug(
				'Consumer "resume" event [originator:%s]', originator);
		});

		consumer.on('effectiveprofilechange', (profile) =>
		{
			logger.debug(
				'Consumer "effectiveprofilechange" event [profile:%s]', profile);
		});

		// If video, initially make it 'low' profile unless this is for the current
		// active speaker.
		if (consumer.kind === 'video' && consumer.peer !== this._currentActiveSpeaker)
			consumer.setPreferredProfile('low');
	}

	_handleMediasoupClientRequest(protooPeer, request, accept, reject)
	{
		logger.debug(
			'mediasoup-client request [method:%s, peer:"%s"]',
			request.method, protooPeer.id);

		switch (request.method)
		{
			case 'queryRoom':
			{
				this._mediaRoom.receiveRequest(request)
					.then((response) => accept(response))
					.catch((error) => reject(500, error.toString()));

				break;
			}

			case 'join':
			{
				// TODO: Handle appData. Yes?
				const { peerName } = request;

				if (peerName !== protooPeer.id)
				{
					reject(403, 'that is not your corresponding mediasoup Peer name');

					break;
				}
				else if (protooPeer.data.mediaPeer)
				{
					reject(500, 'already have a mediasoup Peer');

					break;
				}

				this._mediaRoom.receiveRequest(request)
					.then((response) =>
					{
						accept(response);

						// Get the newly created mediasoup Peer.
						const mediaPeer = this._mediaRoom.getPeerByName(peerName);

						protooPeer.data.mediaPeer = mediaPeer;

						this._handleMediaPeer(protooPeer, mediaPeer);
					})
					.catch((error) =>
					{
						reject(500, error.toString());
					});

				break;
			}

			default:
			{
				const { mediaPeer } = protooPeer.data;

				if (!mediaPeer)
				{
					logger.error(
						'cannot handle mediasoup request, no mediasoup Peer [method:"%s"] [mcuIndex:%d, roomId:"%s", peerName:"%s"]',
						request.method, this.mcuIndex, this._roomId, protooPeer.id);

					reject(400, 'no mediasoup Peer');
				}

				// TODO: Temporal to catch a possible bug.
				if (request.method === 'createTransport')
				{
					logger.debug(
						'"createTransport" request [peer.name:%s, transport.id:%s, direction:%s]',
						mediaPeer.name, request.id, request.direction);
				}

				mediaPeer.receiveRequest(request)
					.then((response) => accept(response))
					.catch((error) => reject(500, error.toString()));
			}
		}
	}

	_handleMediasoupClientNotification(protooPeer, notification)
	{
		logger.debug(
			'mediasoup-client notification [method:%s, peer:"%s"]',
			notification.method, protooPeer.id);

		// NOTE: mediasoup-client just sends notifications with target 'peer',
		// so first of all, get the mediasoup Peer.
		const { mediaPeer } = protooPeer.data;

		if (!mediaPeer)
		{
			logger.error(
				'cannot handle mediasoup notification, no mediasoup Peer [method:"%s"] [mcuIndex:%d, roomId:"%s", peerName:"%s"]',
				notification.method, this.mcuIndex, this._roomId, protooPeer.id);

			return;
		}

		mediaPeer.receiveNotification(notification);
	}

	_updateMaxBitrate(transport, protooPeer)
	{
		if (this._mediaRoom.closed)
			return;

		let newMaxBitrate = Math.min(this._bandwidth, protooPeer.maxJoinnetBitrate);
		newMaxBitrate = Math.min(MAX_BITRATE, (Math.max(MIN_BITRATE, newMaxBitrate)));

		if(transport.oldMaxBitrate != newMaxBitrate) {
			logger.debug('protoo Peer [mcuIndex:%d, roomId:"%s", peer:"%s", transportId:%s] set webrtc MaxBitrate from %d to %d',
				this.mcuIndex, this._roomId, protooPeer.id, transport.id,
				transport.oldMaxBitrate, newMaxBitrate);
			transport.oldMaxBitrate = newMaxBitrate;
			transport.setMaxBitrate(newMaxBitrate)
				.catch((error) => {
					logger.error('protoo Peer [mcuIndex:%d, roomId:"%s", peer:"%s", transportId:%s] setMaxBitrate failed: %s',
						this.mcuIndex, this._roomId, protooPeer.id, transport.id, String(error));
				});
		}
	}
}

module.exports = Room;
