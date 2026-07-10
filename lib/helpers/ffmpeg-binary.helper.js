const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { spawnSync } = require('child_process');

// Release of https://github.com/eugeneware/ffmpeg-static that provides raw,
// gzip-compressed static ffmpeg binaries per platform/arch (no tar/zip needed).
const FFMPEG_STATIC_RELEASE = 'b6.1.1';
const FFMPEG_STATIC_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}`;

// platform/arch combinations that ffmpeg-static publishes prebuilt binaries for
const SUPPORTED_DOWNLOAD_TARGETS = {
    darwin: ['x64', 'arm64'],
    freebsd: ['x64'],
    linux: ['x64', 'ia32', 'arm64', 'arm'],
    win32: ['x64', 'ia32'],
};

const MAX_REDIRECTS = 5;

// Resolves a working ffmpeg binary for the machine this app is actually running on.
// Homey Pro hardware ships with binaries bundled inside the app (bin/ffmpeg-arm*),
// but a self-hosted Homey server can run on other OS/CPU combinations (eg. x64 Linux)
// for which no binary is bundled, or on a libc that the bundled binary can't run on.
// In that case we download a matching static build once and cache it in userdata.
class FfmpegBinaryResolver {
    constructor(homey) {
        this.homey = homey;
        this.downloadDir = path.join(path.resolve(__dirname, '/userdata/'), 'bin');
    }

    log(...args) {
        if (this.homey?.app?.log) this.homey.app.log(...args);
    }

    error(...args) {
        if (this.homey?.app?.error) this.homey.app.error(...args);
    }

    // Binaries shipped inside the app, built for official Homey Pro hardware.
    getBundledPath() {
        if (os.platform() !== 'linux') return null;

        if (os.arch() === 'arm64') return path.join(__dirname, '../../bin', 'ffmpeg-arm64'); // HP23
        if (os.arch() === 'arm') return path.join(__dirname, '../../bin', 'ffmpeg-arm32'); // HP19

        return null;
    }

    isExecutable(binPath) {
        try {
            fs.accessSync(binPath, fs.constants.X_OK);
            const result = spawnSync(binPath, ['-version'], { timeout: 5000 });
            return result.status === 0;
        } catch (error) {
            return false;
        }
    }

    getDownloadTarget() {
        const platform = os.platform();
        const arch = os.arch();

        if (!SUPPORTED_DOWNLOAD_TARGETS[platform]?.includes(arch)) return null;

        return { platform, arch };
    }

    getDownloadedPath({ platform, arch }) {
        const ext = platform === 'win32' ? '.exe' : '';
        return path.join(this.downloadDir, `ffmpeg-${platform}-${arch}${ext}`);
    }

    download(url, destPath, redirectsLeft = MAX_REDIRECTS) {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            const cleanup = () => fs.unlink(destPath, () => {});

            const request = https.get(url, { headers: { 'User-Agent': 'homey-eufy-security' } }, (response) => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    response.resume();
                    file.close();
                    cleanup();
                    if (redirectsLeft <= 0) {
                        reject(new Error('Too many redirects while downloading ffmpeg binary'));
                        return;
                    }
                    resolve(this.download(response.headers.location, destPath, redirectsLeft - 1));
                    return;
                }

                if (response.statusCode !== 200) {
                    response.resume();
                    file.close();
                    cleanup();
                    reject(new Error(`Failed to download ffmpeg binary: HTTP ${response.statusCode}`));
                    return;
                }

                const gunzip = zlib.createGunzip();

                response.on('error', (err) => {
                    file.close();
                    cleanup();
                    reject(err);
                });
                gunzip.on('error', (err) => {
                    file.close();
                    cleanup();
                    reject(err);
                });
                file.on('error', (err) => {
                    cleanup();
                    reject(err);
                });
                file.on('finish', () => file.close(resolve));

                response.pipe(gunzip).pipe(file);
            });

            request.on('error', (err) => {
                file.close();
                cleanup();
                reject(err);
            });
        });
    }

    async downloadBinary(target) {
        const destPath = this.getDownloadedPath(target);

        if (this.isExecutable(destPath)) {
            this.log('[FfmpegBinaryResolver] - Using previously downloaded ffmpeg binary:', destPath);
            return destPath;
        }

        fs.mkdirSync(this.downloadDir, { recursive: true });

        const { platform, arch } = target;
        const url = `${FFMPEG_STATIC_BASE_URL}/ffmpeg-${platform}-${arch}.gz`;
        const tmpPath = `${destPath}.download`;

        this.log(`[FfmpegBinaryResolver] - Detected ${platform}/${arch}, downloading matching ffmpeg binary from`, url);

        await this.download(url, tmpPath);
        fs.renameSync(tmpPath, destPath);
        fs.chmodSync(destPath, 0o755);

        if (!this.isExecutable(destPath)) {
            throw new Error(`Downloaded ffmpeg binary for ${platform}/${arch} is not runnable on this system`);
        }

        this.log('[FfmpegBinaryResolver] - Downloaded working ffmpeg binary to:', destPath);

        return destPath;
    }

    async resolve() {
        const bundledPath = this.getBundledPath();

        if (bundledPath) {
            if (this.isExecutable(bundledPath)) {
                this.log('[FfmpegBinaryResolver] - Using bundled ffmpeg binary:', bundledPath);
                return bundledPath;
            }

            this.log(
                '[FfmpegBinaryResolver] - Bundled ffmpeg binary does not run on this system, falling back to download:',
                bundledPath
            );
        }

        const target = this.getDownloadTarget();
        if (!target) {
            throw new Error(`Unsupported platform/architecture for ffmpeg: ${os.platform()}/${os.arch()}`);
        }

        return this.downloadBinary(target);
    }
}

module.exports = FfmpegBinaryResolver;
