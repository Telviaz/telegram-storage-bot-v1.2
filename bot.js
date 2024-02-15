//telegram bot for storage using mongo db 
 //file uploader//
 //download file//
//store according to file extension
 //retrive easy by file ID
 //encrypting the file before uploading
//decrypting after downloading
 //upload finsh the chunckes are deleted
 //merging the chuncks after download is finished//

 require('dotenv').config();
 const TelegramBot = require('node-telegram-bot-api');
const MongoClient = require('mongodb').MongoClient;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const stream = require('stream');
const util = require('util');
const pipeline = util.promisify(stream.pipeline);
const uuid = require('uuid');


const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, {polling: true});
const client = new MongoClient(process.env.MONGODB_CONNECTION_STRING, { useNewUrlParser: true, useUnifiedTopology: true });
const dbName = process.env.DB_NAME;
const usersCollectionName = process.env.USERS_COLLECTION;
const downloadPath = path.join(__dirname, 'downloads');
const algorithm = 'aes-256-gcm';
const secretKey = crypto.randomBytes(32);
const chunkSize = 20 * 1024 * 1024; // 20MB
const shareBaseUrl = 'https://your-domain.com/download/';

// const bot = new TelegramBot(process.env.BOT_TOKEN, {polling: true});
// const client = new MongoClient(dbUrl, { useNewUrlParser: true, useUnifiedTopology: true });

let db, collection, usersCollection;

client.connect(err => {
    if (err) {
        console.error('Failed to connect to MongoDB', err);
        process.exit(1);
    }
    db = client.db(dbName);
    collection = db.collection(collectionName);
    usersCollection = db.collection(usersCollectionName);
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Welcome, please register or login to use the bot.", {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Register', callback_data: 'register' }],
                [{ text: 'Login', callback_data: 'login' }]
            ]
        }
    });
});

bot.on('callback_query', async (query) => {
    const action = query.data;
    const msg = query.message;

    if (action === 'register') {
        bot.sendMessage(msg.chat.id, "Please send me your desired username and password in the format: /register <username> <password>");
    } else if (action === 'login') {
        bot.sendMessage(msg.chat.id, "Please send me your username and password in the format: /login <username> <password>");
    } else if (action === 'upload') {
        bot.sendMessage(msg.chat.id, "Please send me the file you want to upload.");
    } else if (action === 'download') {
        bot.sendMessage(msg.chat.id, "Please send me the file id you want to download.");
    } else if (action === 'delete') {
        bot.sendMessage(msg.chat.id, "Please send me the file id you want to delete.");
    }
});

bot.onText(/\/register (.+) (.+)/, async (msg, match) => {
    const username = match[1];
    const password = match[2];
    const user = await usersCollection.findOne({username: username});
    if (user) {
        bot.sendMessage(msg.chat.id, "Username already taken.");
    } else {
        await usersCollection.insertOne({username: username, password: password});
        bot.sendMessage(msg.chat.id, "Registration successful.");
    }
});

bot.onText(/\/login (.+) (.+)/, async (msg, match) => {
    const username = match[1];
    const password = match[2];
    const user = await usersCollection.findOne({username: username});
    if (user && user.password === password) {
        bot.sendMessage(msg.chat.id, "Login successful.", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Upload File', callback_data: 'upload' }],
                    [{ text: 'Download File', callback_data: 'download' }],
                    [{ text: 'Delete File', callback_data: 'delete' }]
                ]
            }
        });
    } else {
        bot.sendMessage(msg.chat.id, "Invalid username or password.");
    }
});

bot.on('document', async (msg) => {
    try {
        const fileId = msg.document.file_id;
        const fileName = msg.document.file_name;
        const fileUrl = await bot.getFileLink(fileId);
        const filePath = path.join(downloadPath, `${fileId}`);
        const file = fs.createWriteStream(filePath);
        await pipeline(https.get(fileUrl), file);
        const fileBuffer = fs.readFileSync(filePath);
        const chunks = [];
        for (let i = 0; i < fileBuffer.length; i += chunkSize) {
            chunks.push(fileBuffer.slice(i, i + chunkSize));
        }
        const cipher = crypto.createCipher(algorithm, secretKey);
        const encryptedChunks = chunks.map(chunk => Buffer.concat([cipher.update(chunk), cipher.final()]));
        fs.unlinkSync(filePath);
        const shareLink = shareBaseUrl + uuid.v4();
        await collection.insertOne({file_id: fileId, file_name: fileName, file_path: filePath, chunks: encryptedChunks, share_link: shareLink});
        bot.sendMessage(msg.chat.id, `File uploaded successfully. Share link: ${shareLink}`);
    } catch (err) {
        console.error('Failed to process document', err);
    }
});

bot.onText(/\/download (.+)/, async (msg, match) => {
    try {
        const fileId = match[1];
        const doc = await collection.findOne({file_id: fileId});
        if (doc) {
            const decipher = crypto.createDecipher(algorithm, secretKey);
            const decryptedChunks = doc.chunks.map(chunk => Buffer.concat([decipher.update(chunk), decipher.final()]));
            const fileBuffer = Buffer.concat(decryptedChunks);
            fs.writeFileSync(doc.file_path, fileBuffer);
            await bot.sendDocument(msg.chat.id, doc.file_path, {caption: doc.file_name});
            fs.unlinkSync(doc.file_path);
        } else {
            bot.sendMessage(msg.chat.id, "File not found.");
        }
    } catch (err) {
        console.error('Failed to download file', err);
    }
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
    try {
        const fileId = match[1];
        const doc = await collection.findOneAndDelete({file_id: fileId});
        if (doc.value) {
            fs.unlink(doc.value.file_path, err => {
                if (err) throw err;
            });
        } else {
            bot.sendMessage(msg.chat.id, "File not found.");
        }
    } catch (err) {
        console.error('Failed to delete file', err);
    }
});