import type {
  AudioSinkPort,
  AudioSourcePort,
  HostRegistration,
  InputInjectorPort,
  TransportPort,
  VideoSourcePort,
} from "@/domain/ports";

export interface RunHostSessionDeps {
  transport:    TransportPort;
  video:        VideoSourcePort;
  audio:        AudioSourcePort;
  audioSink:    AudioSinkPort;
  injector:     InputInjectorPort;
  registration: HostRegistration;
}

export async function runHostSession(deps: RunHostSessionDeps): Promise<void> {
  const { transport, video, audio, audioSink, injector, registration } = deps;

  let inputCount = 0;

  transport.onControl((msg) => {
    if (msg.type === "input") {
      inputCount++;
      if (inputCount === 1 || inputCount % 100 === 0) {
        console.log(`[input] received ${inputCount} events (last: ${msg.event.kind})`);
      }
      injector.apply(msg.event).catch((err) => console.error("[input] inject failed", err));
    } else if (msg.type === "peer-joined" && msg.role === "controller") {
      console.log(`[host] controller "${msg.name ?? "?"}" joined — starting capture`);
      video.start((jpeg) => transport.sendVideo(jpeg)).catch((e) => console.error("[video]", e));
      audio.start((pcm)  => transport.sendAudio(pcm)).catch((e)  => console.error("[audio]", e));
    } else if (msg.type === "peer-left" && msg.role === "controller") {
      console.log("[host] controller left — stopping capture");
      video.stop().catch(() => {});
      audio.stop().catch(() => {});
      audioSink.stop();
    }
  });

  let micChunkCount = 0;
  transport.onMic((pcm) => {
    micChunkCount++;
    if (micChunkCount === 1) console.log("[mic] first chunk received — starting audio sink");
    if (micChunkCount % 500 === 0) console.log(`[mic] ${micChunkCount} chunks received`);
    audioSink.write(pcm);
  });

  await transport.connect(registration);
}
