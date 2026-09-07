// Synthetic tone only: no files, microphones, cameras or playback devices.
import {
  Room,
  RoomEvent,
  AudioSource,
  AudioFrame,
  AudioStream,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node'

if (process.env.AUDIT_MEDIA_SMOKE !== '1' || !process.send)
  throw new Error('disposable admission runner required')
const rooms = []
const sources = []
let running = true,
  received = 0,
  sentReady = false
async function close() {
  running = false
  for (const room of rooms) await room.disconnect()
  for (const source of sources) await source.close()
  await dispose()
  process.exit(0)
}
process.on('message', async (message) => {
  try {
    if (message.type === 'close') {
      await close()
      return
    }
    if (message.type === 'count') {
      process.send({ type: 'count', received })
      return
    }
    if (message.type !== 'start') return
    const { url, senderToken, receiverToken } = message
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/livekit$/.test(url))
      throw new Error('loopback gateway required')
    const sender = new Room(),
      receiver = new Room()
    rooms.push(sender, receiver)
    receiver.on(RoomEvent.TrackSubscribed, (track) => {
      void (async () => {
        for await (const frame of new AudioStream(track, 48000, 1)) {
          if (frame.data.some((value) => Math.abs(value) > 100)) received++
          if (received >= 10 && !sentReady) {
            sentReady = true
            process.send({ type: 'ready', received })
          }
        }
      })().catch(() => {
        /* expected stream shutdown after revocation */
      })
    })
    await sender.connect(url, senderToken, {
      autoSubscribe: true,
      dynacast: false,
      rtcConfig: { iceServers: [] },
    })
    await receiver.connect(url, receiverToken, {
      autoSubscribe: true,
      dynacast: false,
      rtcConfig: { iceServers: [] },
    })
    const source = new AudioSource(48000, 1, 100)
    sources.push(source)
    const track = LocalAudioTrack.createAudioTrack('synthetic-audit-tone', source)
    const options = new TrackPublishOptions()
    options.source = TrackSource.SOURCE_MICROPHONE
    await sender.localParticipant.publishTrack(track, options)
    let sample = 0
    while (running) {
      const samples = new Int16Array(960)
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.round(3000 * Math.sin((2 * Math.PI * 440 * sample++) / 48000))
      await source.captureFrame(new AudioFrame(samples, 48000, 1, 960))
      await new Promise((r) => setTimeout(r, 20))
    }
  } catch (error) {
    // Synthetic test only; no JWTs/URLs in IPC diagnostics.
    process.send({
      type: 'error',
      name: error?.constructor?.name,
      message: String(error?.message).replace(/eyJ\S+/g, '<token>'),
    })
    await close()
  }
})
