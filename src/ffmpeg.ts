import * as os from 'os';
import * as path from 'path';

import { Config } from './config';
import { Util } from './util';
import { RecordingOptions } from './types';

export class FFmpegUtil {

  static recordingArgs = {
    common: {
      threads: 4,
      capture_cursor: 1,
    },
    audio: {
      'b:a': '384k',
      'c:a': 'aac',
      ac: 1,
      vbr: 3
    },
    video: {
      preset: 'ultrafast',
      crf: 22,
      'c:v': 'libx264',
    }
  };

  private static get(src: any, key: string, target: any, customKeyOverride?: string) {
    return [`-${key}`, src[customKeyOverride || key] || target[key]];
  }

  private static getAll(src: any, target: any, keys: string[] = Object.keys(target), override?: (x: string) => string) {
    return keys.reduce((acc, k) => {
      acc.push(...this.get(src, k, target, override ? override(k) : k));
      return acc;
    }, [] as string[]);
  }

  static async getMacInputDevices(opts: RecordingOptions) {
    const { finish, proc } = Util.processToPromise(opts.ffmpegBinary, ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""']);
    proc.stderr.removeAllListeners('data');
    const lines: Buffer[] = [];
    proc.stderr.on('data', buffer => lines.push(buffer));
    try {
      await finish;
    } catch (e) {
      // Expect an error code
    }
    const text = Buffer.concat(lines).toString();
    const matchedIndex = text.match(/\[(\d+)\]\s+Capture\s+Screen/i)!;
    if (!matchedIndex) {
      throw new Error('Cannot find screen recording device');
    }
    const videoIndex = matchedIndex[1].toString();
    if (!opts.audio) {
      return `'${videoIndex}:none'`;
    } else {
      const matchedAudioIndex = text.match(/\[(\d+)\]\s+Mac[^\n]*Microphone/i)!;
      if (!matchedAudioIndex) {
        throw new Error('Cannot find microphone recording device');
      }
      const audioIndex = matchedAudioIndex[1].toString();
      return `'${videoIndex}:${audioIndex}'`;
    }
  }

  static async getInputDevices(opts: RecordingOptions) {
    switch (os.platform()) {
      case 'darwin': {
        const { proc, finish } = await Util.processToPromise('osascript', ['-e', `'tell application "Finder" to get bounds of window of desktop'`]);
        let w: number = 0, h: number = 0;
        proc.stdout.on('data', v => {
          [, , w, h] = v.toString().split(/\s*,\s*/);
          w = parseInt(`${w}`, 10);
          h = parseInt(`${h}`, 10);
        });
        await finish;
        return {
          resolution: { w, h },
          video: {
            f: 'avfoundation',
            i: await this.getMacInputDevices(opts)
          }
        };
      }
      case 'win32': {
        return {
          video: {
            f: 'dshow',
            i: opts.audio ?
              'video="UScreenCapture":audio="Microphone"' :
              'video="screen-capture-recorder"'
          }
        };
      }
      case 'linux': {
        return {
          video: { f: 'x11grab', i: `:0.0` },
          ...(!opts.audio ? {} : {
            audio: { f: 'pulse', i: 'default' }
          })
        };
      }
    }
  }

  static async launchProcess(opts: RecordingOptions) {
    const custom = opts.flags || {};

    const input = await this.getInputDevices(opts);
    if (!input) {
      throw new Error('Unsupported platform');
    }

    const getAll = this.getAll.bind(this, custom);

    const args: string[] = [
      ...getAll(this.recordingArgs.common),
      '-r', `${opts.fps}`,
      '-video_size', `${opts.bounds.width}x${opts.bounds.height}`,
      ...getAll(input.video, ['f']),
      ...getAll(input.video, ['i'])
    ];

    if (opts.duration) {
      args.unshift('-t', `${opts.duration}`);
    }

    if (opts.audio) {
      if ('audio' in input) {
        args.push(
          ...getAll(input.audio, ['f'], x => `audio_${x}`),
          ...getAll(input.audio, ['i'], x => `audio_${x}`),
        );
      }
      args.push(
        ...getAll(this.recordingArgs.audio),
      );
    }

    let vf = `crop=${opts.bounds.width}:${opts.bounds.height}:${opts.bounds.x}:${opts.bounds.y}`;
    if (input.resolution) {
      vf = `scale=${input.resolution.w}:${input.resolution.h}:flags=lanczos,${vf}`;
    }
    args.push(
      ...getAll(this.recordingArgs.video),
      '-vf', `'${vf}'`
    );

    const { finish, kill, proc } = await Util.processToPromise(opts.ffmpegBinary, [...args, opts.file]);
    return { finish: finish.then(x => opts), kill, proc };
  }

  static async generateGIF(opts: RecordingOptions & { scale?: number }) {
    const ffmpeg = await Config.getFFmpegBinary();

    if (!ffmpeg) {
      return;
    }

    let vf = `fps=${opts.fps}`;
    if (opts.scale) {
      vf = `${vf},scale=${Math.trunc(opts.bounds.width * opts.scale)}:${Math.trunc(opts.bounds.height * opts.scale)}`;
    } else {
      vf = `${vf},scale=${opts.bounds.width}:${opts.bounds.height}`;
    }

    vf = `${vf}:flags=lanczos`;

    const paletteFile = path.resolve(os.tmpdir(), 'palette-gen.png');
    const final = opts.file.replace('.mp4', '.gif');

    const { finish: finishPalette } = Util.processToPromise(ffmpeg, [
      '-i', opts.file,
      '-vf', `${vf},palettegen=stats_mode=diff`,
      '-y', paletteFile
    ]);

    await finishPalette;

    const { finish, kill } = Util.processToPromise(ffmpeg, [
      '-i', opts.file,
      '-i', paletteFile,
      '-lavfi', `"${vf},paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"`,
      '-y', final
    ]);

    return { finish: finish.then(x => final), kill };
  }
}