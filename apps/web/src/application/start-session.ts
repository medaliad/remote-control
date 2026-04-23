import type {
  AudioPlayerPort,
  ConnectRequest,
  TransportPort,
  VideoRendererPort,
} from "@/domain/ports";

export interface StartSessionDeps {
  transport: TransportPort;
  video:     VideoRendererPort;
  audio:     AudioPlayerPort;
}

export async function startSession(req: ConnectRequest, deps: StartSessionDeps): Promise<void> {
  deps.transport.onVideo((jpeg) => deps.video.render(jpeg));
  deps.transport.onAudio((pcm) => deps.audio.enqueue(pcm));
  await deps.audio.start();
  await deps.transport.connect(req);
}
