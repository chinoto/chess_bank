(async () => {
    let db = new (require('./ChessDbFile.js'))();
    let cortana = await db.createStudent('Cortana', 'GuiltySpark343');
    let zangetsu = await db.createStudent('Zangetsu', 'GetsugaTensho');
    // Deposit money from "the world" to cortana
    await db.createTransaction(0, cortana, 20);
    await db.createTransaction(cortana, zangetsu, 5);
})();
