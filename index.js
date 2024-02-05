import fs from 'fs';
import process from 'process';
import dotenv from 'dotenv';
import https from 'https';
import path from 'path';
import { exec } from 'child_process';
import decompress from 'decompress';

dotenv.config();

// Now you can access the environment variables defined in the .env file
const { MODIO_API_TOKEN, MODIO_API, GAMES, INSTALLBEPINEX } = process.env;
const die = (message) => { console.error(message); process.exit(1); };
const request = async (path) => {
    const url = `${MODIO_API}/${path}`;
    const headers = {
        'Authorization': `Bearer ${MODIO_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
    const response = await fetch(url, {
        method: 'GET',
        headers
    }).then(response => response.json());
    if (!response) die("request failed");
    if (response.error) die(response.error.message);
    return response;
};

const { data: subbed } = await request(`me/subscribed/`);

if (!subbed) die("No subscriptions found");
const gameRequests = new Map();
const gamesMap = new Map();
const mods = {};
subbed.forEach(sub => {
    if (!mods[sub.game_id]) mods[sub.game_id] = [];
    mods[sub.game_id].push(sub);

    if (!gameRequests.has(sub.game_id)) {
        const gameRequest = request(`games/${sub.game_id}`);
        gameRequests.set(sub.game_id, gameRequest);
        gameRequest.then(game => {
            gamesMap.set(sub.game_id, game);
        });
    }
});

await Promise.all([...gameRequests.values()]);

const games_all = [...gamesMap.values()].map(g => ({ name: g.name, name_id: g.name_id, id: g.id }));
const game_list = GAMES.split(',').map(s => s.trim()).filter(Boolean);
const games = games_all.filter(g => (game_list.includes(g.name_id) || game_list.includes(g.id))).map(g => ({ ...g, mods: mods[g.id] }));

const downloadFile = (url, destPath) => {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { 'User-Agent': 'NodeJS', 'Authorization': `Bearer ${MODIO_API_TOKEN}`, }, timeout: 30 * 1000 }, (response) => {
            // Check for redirect
            if (response.statusCode === 301 || response.statusCode === 302) {
                // If redirected, call the function again with the new location
                downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
                return;
            }

            // Check if the request was successful
            if (response.statusCode !== 200) {
                reject(`Failed to download file: ${response.statusCode}`);
                return;
            }

            const file = fs.createWriteStream(destPath);
            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        });

        request.on('error', (err) => {
            reject(`Error downloading the file: ${err.message}`);
        });
    });
};

const extractFile = (file, destDir) => {
    return decompress(file, destDir);
}
function mkdir(path) {
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path, { recursive: true });
        changePermissions(path);
    }
}
function changePermissions(modDir) {
    exec(`icacls "${modDir}" /grant Everyone:F /T /Q`, (error, stdout, stderr) => {
        if (error) {
            console.error('Error changing permissions:', error);
        }
    });
}
async function deleteDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
        for (const dirent of await fs.promises.readdir(dirPath, { withFileTypes: true })) {
            const fullPath = path.join(dirPath, dirent.name);
            if (dirent.isDirectory()) {
                await deleteDirectory(fullPath);
            } else {
                await fs.promises.unlink(fullPath);
            }
        }
        await fs.promises.rmdir(dirPath);
    }
}

async function* downloadMod(games) {
    for (const game of games) {
        const gameDir = `./${game.name_id}-mods/`;
        game.total = game.mods.length;
        game.downloaded = 0;
        game.extracted = 0;
        game.failed_download = 0;
        game.failed_extract = 0;
        await deleteDirectory(gameDir);
        mkdir(gameDir);

        for (const mod of game.mods) {
            const { name_id, modfile } = mod;
            const downloadDir = `${gameDir}downloads/`;
            const modDir = `${downloadDir}${name_id}/`;

            mkdir(modDir);
            const modFile = `${modDir}${modfile.filename}`;

            try {
                await downloadFile(modfile.download.binary_url, modFile);
                game.downloaded++;
                changePermissions(modFile);

                try {
                    await extractFile(modFile, modDir);
                    game.extracted++;
                    console.log(`${game.extracted}/${game.total} ${modfile.filename} extracted successfully.`);
                    fs.renameSync(modFile, `${downloadDir}${modfile.filename}`);
                    yield modfile; // Yield the game object for each successful extraction
                } catch (extractError) {
                    game.failed_extract++;
                    yield extractError; // Yield the error object
                }
            } catch (downloadError) {
                game.failed_download++;
                yield downloadError; // Yield the error object
            }
        }
    }
}

for await (const modOrError of downloadMod(games)) {
    if (modOrError instanceof Error) {
        // Handle error
        console.error(modOrError);
    }
}
// recursively move all files and folders from src to dest
function moveFile(src, dest) {
    if (fs.lstatSync(src).isDirectory()) {
        mkdir(dest);
        fs.readdirSync(src).forEach(file => {
            moveFile(`${src}/${file}`, `${dest}/${file}`);
        });
        fs.rmdirSync(src);
    } else {
        fs.renameSync(src, dest);
    }
}

const getPluginsDir = (path) => {
    const filesAll = fs.readdirSync(path);
    const folders = filesAll.filter(f => fs.lstatSync(`${path}/${f}`).isDirectory());
    const files = filesAll.filter(f => !folders.includes(f));
    const hasFiles = files.length >= 1;
    let pluginsDir = path;
    const hasBepInEx = folders.includes('BepInEx');
    const isBebInEx = hasBepInEx && folders.includes('doorstop_libs') && files.includes('doorstop_config.ini');
    if (hasFiles) {
        return {
            pluginsDir,
            files,
            folders,
            hasBepInEx,
            isBebInEx,
        };
    }
    if (!hasFiles && folders.length === 1) {
        const insideDir = `${pluginsDir}/${folders[0]}`.replaceAll('//', '/');
        const considerFound = ['plugins', 'core']
        if (considerFound.includes(folders[0])) {
            if(folders[0] === 'plugins') {
                pluginsDir = insideDir;
            }
            return {
                pluginsDir,
                files,
                folders,
                hasBepInEx,
                isBebInEx,
            };
        }
        return getPluginsDir(insideDir);
    }
    return {
        failed: true,
        pluginsDir,
        files,
        folders,
        hasBepInEx,
        isBebInEx,
    };
}
function getGameDir(game) {
    const gameKey = `GAMES_${game.name_id.toUpperCase()}`;
    const gameDir = process.env[gameKey];
    if (!gameDir) {
        return false
    }
    if(!fs.existsSync(gameDir)){
        console.error(`Failed to find ${game.name} path: ${gameDir}`);
        return false
    }
    return gameDir;
}
for (const game of games) {
    console.log(`${game.name} mods:`, {
        total: game.total,
        downloaded: game.downloaded,
        extracted: game.extracted,
        failed_download: game.failed_download,
        failed_extract: game.failed_extract,
    });
    const gameDir = `./${game.name_id}-mods/`;
    const bepinexDir = `${gameDir}BepInEx-install/`;
    const pluginsDir = `${bepinexDir}BepInEx/plugins/`;

    game.mods.forEach(mod => {
        const modDir = `${gameDir}downloads/${mod.name_id}/`;
        const desDir = `${pluginsDir}${mod.name_id}/`;
        const pdir = getPluginsDir(modDir);
        if (pdir.isBebInEx) {
            if(INSTALLBEPINEX === 'true') {
                console.log("installing: BepInEx");
                moveFile(pdir.pluginsDir, bepinexDir);
            } else {
                console.log("Skipping BepInEx install: ", bepinexDir);
            }
        } else {
            console.log("installing: ", mod.name_id);
            mkdir(desDir);
            moveFile(pdir.pluginsDir, desDir);
        }
    });
    const gameDirPath = getGameDir(game);
    if(gameDirPath) {
        console.log("Copying: ", bepinexDir);
        console.log("To: ", gameDirPath);
        moveFile(bepinexDir, gameDirPath);
    }
}


console.log('All done!', {
    games_total: games.length,
    total_mods: games.reduce((acc, g) => acc + g.total, 0),
    downloaded: games.reduce((acc, g) => acc + g.downloaded, 0),
    extracted: games.reduce((acc, g) => acc + g.extracted, 0),
});
process.exit(0);
