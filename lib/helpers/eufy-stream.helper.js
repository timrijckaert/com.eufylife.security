const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { waitUntil } = require('../utils');
const FfmpegBinaryResolver = require('./ffmpeg-binary.helper');

class FfmpegManager {
    constructor(homey) {
        this.homey = homey;
        this.proc = null;
        this.snapshotTasks = new Map();
        this.ffmpegBinaryResolver = new FfmpegBinaryResolver(homey);
    }

    async streamHandler(videoStream, audioStream, device) {
        await this.stopStream();

        const deviceSn = device.getSerial();
        const streamLength = this.homey.app.eufyClient.getCameraMaxLivestreamDuration();

        this.homey.app.log(`[streamHandler] - Got handleStream: ${device.getName()} - ${deviceSn}`, { streamLength });

        audioStream.destroy();

        this.currentVideoStream = videoStream;

        return this.takeSnapshot(deviceSn);
    }

    // --- Take snapshot ---
    takeSnapshot(deviceSn) {
        let finished = false;

        const userDataPath = path.resolve(__dirname, '/userdata/');
        const snapshotPath = path.join(userDataPath, `${deviceSn}_snapshot.jpg`);
        this.homey.app.log('[takeSnapshot] - Going to save snapshot to:', snapshotPath);

        const videoStream = this.currentVideoStream;

        const snapshotPromise = this.getFFMPEGPath().then(
            (ffmpegPath) =>
                new Promise((resolve, reject) => {
                    const ffmpegInstance = ffmpeg(videoStream);

                    if (ffmpegPath) ffmpegInstance.setFfmpegPath(ffmpegPath);

                    const cmd = ffmpegInstance
                        .seekOutput(0.4)
                        .outputOptions('-vframes 1')
                        .save(snapshotPath)
                        .on('end', () => {
                            try {
                                if (finished) return; // ignore duplicate events
                                finished = true;
                                const stats = fs.statSync(snapshotPath);
                                if (!stats.size) {
                                    throw new Error('Snapshot file is empty');
                                }

                                this.homey.app.log(`[takeSnapshot] - Snapshot saved: ${snapshotPath}`);
                                if (this.proc === cmd) this.proc = null;
                                resolve(snapshotPath);
                            } catch (error) {
                                this.homey.app.error('[takeSnapshot] - Snapshot verification failed:', error);
                                if (this.proc === cmd) this.proc = null;
                                reject(error);
                            }
                        })
                        .on('error', (err) => {
                            if (finished) return; // ignore duplicate events
                            finished = true;

                            this.homey.app.error('[takeSnapshot] - FFmpeg error:', err);
                            if (this.proc === cmd) this.proc = null;
                            reject(err);
                        });

                    cmd.run();
                    this.proc = cmd;
                })
        );

        snapshotPromise.finally(() => {
            this.finishSnapshotTask(deviceSn, snapshotPromise);
        });

        this.trackSnapshotTask(deviceSn, snapshotPromise);

        return snapshotPromise;
    }

    trackSnapshotTask(deviceSn, snapshotPromise) {
        this.snapshotTasks.set(deviceSn, { promise: snapshotPromise, startedAt: Date.now(), finished: false });
    }

    finishSnapshotTask(deviceSn, snapshotPromise) {
        const existingTask = this.snapshotTasks.get(deviceSn);
        if (existingTask) {
            this.snapshotTasks.set(deviceSn, { ...existingTask, finished: true });
        }
    }

    async waitForSnapshot(deviceSn, timeoutMs = 10000, since = 0) {
        const status = await waitUntil(
            () => {
                const entry = this.snapshotTasks.get(deviceSn);
                return !!entry && entry.finished && entry.startedAt >= since;
            },
            `Snapshot could not be made. Stream couldn't be started. Please try again.`,
            300,
            timeoutMs
        );

        this.snapshotTasks.delete(deviceSn);
        return status;
    }

    async stopStream(device = null) {
        try {
            if (this.proc) {
                this.homey.app.log('[stopStream] Stopping proc...', device ? `for device ${device.getSerial()}` : '');
                this.proc.kill();
                this.proc = null;
            } else {
                this.homey.app.log('[stopStream] No active proc to kill.');
            }

            if (this.currentVideoStream) {
                this.homey.app.log('[stopStream] Stopping videostream...', device ? `for device ${device.getSerial()}` : '');
                this.currentVideoStream.removeAllListeners('data');
                this.currentVideoStream.removeAllListeners('end');
                this.currentVideoStream.destroy();
                this.currentVideoStream = null;
            } else {
                this.homey.app.log('[stopStream] No active videostream to destroy.');
            }
        } catch (error) {
            this.homey.app.error('[stopStream] Error stopping stream:', error);
        }
    }

    getFFMPEGPath() {
        // Cache the resolution (and any download it triggers) so it only happens once per run.
        if (!this.ffmpegPathPromise) {
            this.ffmpegPathPromise = this.ffmpegBinaryResolver.resolve().catch((error) => {
                this.ffmpegPathPromise = null; // allow a retry on the next snapshot attempt
                throw error;
            });
        }

        return this.ffmpegPathPromise;
    }

    async writeMediaMtxYmlFile(port) {
        const config = `
rtsp: yes
rtmp: no
hls: no
webrtc: no
srt: no

rtspEncryption: "no"
rtspTransports: [tcp]
rtspAddress: :${port}

paths:
  all:
    source: publisher
`;

        const userDataPath = path.resolve(__dirname, '/userdata/');
        const configPath = path.join(userDataPath, 'mediamtx.yml');
        fs.writeFileSync(configPath, config);
        return configPath;
    }
}

module.exports = FfmpegManager;
