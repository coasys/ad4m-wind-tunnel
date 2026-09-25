/**
 * The fake microphone: Chrome loops a WAV passed with `--use-file-for-fake-audio-capture`.
 */

import { execFileSync } from "child_process";
import { join } from "path";

/**
 * Converts the speech clip to 48 kHz mono 16-bit PCM and pads it with silence.
 *
 * The silence is load-bearing: WE's worklet only closes an utterance on a pause, and its
 * transcript writes a block after three quiet seconds. A clip looped back to back would read as
 * one endless utterance that never flushes.
 */
export function prepareSpeechWav(ffmpeg: string, input: string, outDir: string, silenceSeconds = 6): string {
  const out = join(outDir, "u1-speech.wav");
  execFileSync(
    ffmpeg,
    ["-nostdin", "-y", "-loglevel", "error", "-i", input, "-af", `apad=pad_dur=${silenceSeconds}`, "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", out],
    { stdio: "pipe", timeout: 60000 },
  );
  return out;
}
