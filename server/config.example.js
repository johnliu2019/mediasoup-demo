module.exports =
{
	tls :
	{
		cert : `${__dirname}/certs/rtc.crt`,
		key  : `${__dirname}/certs/rtc.key`
	},
	mediasoup :
	{
		// signal server port
		signalServerPort : 443,
		// MCU list
		mcu:
		[
			// 'wss://mcu1.com/mediasoup/',
			// 'wss://mcu2.com/mediasoup/',
			// 'wss://mcu3.com/mediasoup/',
		],
		// mediasoup Server settings.
		logLevel : 'warn',
		logTags  :
		[
			'info',
			'ice',
			'dtls',
			'rtp',
			'srtp',
			'rtcp',
			'rbe',
			'rtx'
		],
		rtcIPv4          : true,
		rtcIPv6          : false,
		// change to public IP such as '1.2.3.4' if running behind NAT
		rtcAnnouncedIPv4 : null,
		rtcAnnouncedIPv6 : null,
		rtcMinPort       : 40000,
		rtcMaxPort       : 49999,
		// mediasoup Room codecs.
		mediaCodecs      :
		[
			{
				kind       : 'audio',
				name       : 'opus',
				clockRate  : 48000,
				channels   : 2,
				parameters :
				{
					useinbandfec : 1
				}
			},
			{
				kind: 'audio',
				name: 'G722',
				mimeType: 'audio/G722',
				preferredPayloadType: 9,
				clockRate: 8000
			},
			{
				kind      : 'video',
				name      : 'VP8',
				clockRate : 90000
			},
			{
				kind       : 'video',
				name       : 'H264',
				clockRate  : 90000,
				parameters :
				{
					'packetization-mode' : 1
				}
			},
		],
		// mediasoup per Peer sending bitrate (in bps).
		maxBitrate     : 1500000,
		defaultBitrate : 500000
	}
};
