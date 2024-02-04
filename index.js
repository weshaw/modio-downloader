import fs from 'fs';
import dotenv from 'dotenv';
import https from 'https';
import https from 'https';
dotenv.config();

// Now you can access the environment variables defined in the .env file
const { MODIO_API_TOKEN, MODIO_API, GAMES } = process.env;
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
console.log(games);

games.forEach(game => {
    // create directory for game
    const gameDir = `./${game.name_id}-mods/`;
    if (!fs.existsSync(gameDir)) fs.mkdirSync(gameDir);

    // download mods for game
    const downloadPromises = game.mods.map(mod => {
        return new Promise((resolve, reject) => {
            const { name_id, modfile } = mod;
            const modDir = `${gameDir}${name_id}/`;
            if (!fs.existsSync(modDir)) fs.mkdirSync(modDir);
            const modFile = `${modDir}${modfile.filename}`;

            const file = fs.createWriteStream(modFile);
            https.get(modfile.download, response => {
                response.pipe(file);
                file.on('finish', () => {
                    file.close(resolve);
                });
            }).on('error', (err) => {
                fs.unlink(modFile);
                reject(err.message);
            });
        });

    
    });

});
