const fs = require('fs-extra');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const lockFile = require('lockfile');

//Use this to prevent outside scripts from modifying internal data.
function breakRefs(obj) { return JSON.parse(JSON.stringify(obj)); }

//Everything that touches this.db must behave asynchronously to allow for
//implementations that are actually asynchronous by nature.
class ChessDbFile {
	constructor() {
		//Only allow one instance to be active.
		lockFile.lockSync('bank.lock');

		let bankStr, db;
		//a+ mode should allow reading and create the file if it doesn't exist.
		if (fs.existsSync('bank.json')) {
			try { bankStr = fs.readFileSync('bank.json', 'utf8', 'a+').trim(); }
			catch (e) { console.log('ERROR: bank.json could not be read.', e); process.exit(ERRORS.READ); }
		}
		else { bankStr = ''; }

		if (bankStr[0] === "{") {
			try { db = this.db = JSON.parse(bankStr); }
			catch (e) {
				console.log('ERROR: bank.json could not be parsed.', e);
				process.exit(ERRORS.PARSE);
			}
		} else if (bankStr.length) {
			console.log('ERROR: bank.json does not start with a "{".')
			process.exit(ERRORS.PARSE);
		} else {
			db = this.db = {};
		}

		if (!db.students) { db.students = []; }
		if (!db.transactions) { db.transactions = []; }

		this.writeP = null;
	}

	//returns uuid.
	async createStudent(name, password) {
		if (name.trim() !== name) {
			throw new Error('Name must not have leading/trailing spaces');
		}
		if (name.length === 0) {
			throw new Error('Name must be provided');
		}
		if (password.length < 10) {
			throw new Error('Password must be at least 10 characters');
		}
		if (this.db.students.filter(x => x.name === name).length) {
			throw new Error(`User "${name}" already exists.`);
		}

		let uuid;
		do {
			uuid = uuidv4()
		} while (this.db.students.filter(x => x.uuid === uuid).length);

		this.db.students.push({
			uuid,
			name,
			pash: (await bcrypt.hash(password, 10)),
			balance: 0
		});

		this.scheduleWrite();
		return uuid;
	}

	async verifyStudent(name, password) {
		let ret = { student: false, err: [] };
		if (name.length === 0) { ret.err.push('Name must not be blank'); }
		if (password.length === 0) { ret.err.push('Password must not be blank'); }
		if (ret.err.length) { return ret; }

		let students = this.db.students.filter(x => x.name === name);
		if (students.length > 1) {
			console.log(`ERROR: UUID ${name} is not unique!`);
			process.exit(ERRORS.DUPLICATE);
		}
		if (students.length === 0) { ret.err.push(`"${name}" does not exist`); return ret; }

		if (!(await bcrypt.compare(password, students[0]['pash']))) {
			ret.err.push(`Wrong password`);
			return ret;
		}

		ret.student = students[0];
	}

	async getAllStudents() {
		return breakRefs(this.db.students);
	}

	/*
	WARNING: _ref allows modifying a student through the return of this function,
	thus it shouldn't be used outside this class, otherwise the external API
	wouldn't be compatible with, for example, a PostgreSQL implementation. Within
	this class, it can be used for easily updating a student or bypassing the
	performance hit of using breakRefs().
	*/
	async getStudentByUUID(uuid, _ref = false) {
		let students = this.db.students.filter(x => x.uuid === uuid);
		return this.getStudentCheck(students, uuid, _ref);
	}

	async getStudentByName(name, _ref = false) {
		let students = this.db.students.filter(x => x.name === name);
		return this.getStudentCheck(students, name, _ref);
	}

	getStudentCheck(students, identifier, _ref) {
		if (students.length > 1) {
			console.log(`ERROR: Multiple students found for "${identifier}"!`);
			process.exit(ERRORS.DUPLICATE);
		}
		//When _ref is false, use JSON to break references.
		return (students.length === 1
			? (_ref ? students[0] : breakRefs(students[0]))
			: null);
	}

	async getStudentBalance(uuid, recalc = false) {
		if (uuid === 0) { return 10000; } //No student should ever have more than this
		let student = await this.getStudentByUUID(uuid, true);
		if (!student) { this.nullStudentError(uuid); }
		if (recalc) {
			student.balance = this.db.transactions.reduce((bal, tx) =>
				bal + (tx.amount | 0) * ((tx.to === uuid) - (tx.from === uuid))
				, 0);
			this.scheduleWrite();
		}
		return student.balance;
	}

	//Return new balances of from and to if successful, otherwise null.
	async createTransaction(from, to, amount, memo = '') {
		if (from === to) { throw new Error('Self to self money transfer doesn\'t make sense'); }
		if (amount !== (amount | 0)) { throw new Error('Amounts must be integers'); }
		if (amount <= 0) { throw new Error('Amount must be greater than 0'); }

		if (from === 0) { } //Money is being deposited
		else if ((await this.getStudentBalance(from, true)) < amount) { return null; }

		if (to === 0) { } //Money is being withdrawn
		if (!await this.getStudentByUUID(to, true)) { this.nullStudentError(to); }
		this.db.transactions.push({ time: Date.now(), from, to, amount, memo });
		let ret = await Promise.all([this.getStudentBalance(from, true), this.getStudentBalance(to, true)]);
		this.scheduleWrite();
		return ret;
	}

	nullStudentError(uuid) {
		throw new Error(`Student with UUID '${uuid}' does not exist`);
	}

	//Do not wait for this function, it will unnecessarily block the application.
	async scheduleWrite() {
		//writeP is truthy when a write is currently scheduled.
		if (this.writeP) { return this.writeP; }
		//Create a promise for other scheduleWrite calls to return and
		//assign its resolver to finish.
		let finish;
		let writeP = this.writeP = new Promise(res => finish = res);
		//Wait 1 second for other database changes to queue up.
		await new Promise(res => setTimeout(res, 1000));
		//Write the database to file as JSON and
		//append a newline to play nice with cat.
		await fs.writeFile('bank.json', JSON.stringify(this.db, null, 2) + '\n');
		//Allow new writes to be scheduled and resolve the write promise.
		this.writeP = null;
		finish();
		return writeP;
	}
}

//Error codes in powers of two in case they need to be combined
const ERRORS = ChessDbFile.ERRORS = {
	READ: 1 < 0,
	PARSE: 1 < 1,
	DUPLICATE: 1 < 2
};

module.exports = ChessDbFile;
