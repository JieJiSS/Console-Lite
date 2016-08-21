const crypto = require('crypto');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function _createDir(dir) {
  try {
    if(fs.statSync(dir).isDirectory()) return;
  } catch(e) { }

  const parentDir = path.dirname(dir);
  _createDir(parentDir);
  fs.mkdir(dir);
}

class Conference {
  constructor(name, db, fileRoot) {
    this.name = name;
    this.db = db;
    this.fileRoot = fileRoot;

    _createDir(fileRoot);

    this.listeners = [];
    this.runningTimers = new Map();
    this.timerValues = new Map();
  }

  setup(cb) {
    Promise.all([
      (resolve, reject) => this.db.put('timers', [], err => err ? reject(err) : resolve()),
      (resolve, reject) => this.db.put('seats', [], err => err ? reject(err) : resolve()),
      (resolve, reject) => this.db.put('files', [], err => err ? reject(err) : resolve()),
      (resolve, reject) => this.db.put('votes', [], err => err ? reject(err) : resolve()),
      (resolve, reject) => this.db.put('lists', [], err => err ? reject(err) : resolve()),
    ].map(e => new Promise(e))).then(() => cb(null)).catch(cb);
  }

  /* Timers */

  _startTimer(id, refkey, cb) {
    if(this.runningTimers.has(id)) return cb('AlreadyStarted');
    this.runningTimers.set(id, 0); // To block following invokes

    this.db.get(refkey, (err, value) => {
      if(err) {
        this.runningTimers.delete(id);
        return cb(err);
      } 

      this.timerValues.set(id, value);
      const intId = setInterval(() => {
        const t = this.timerValues.get(id) - 1;
        assert(t >= 0);
        this.timerValues.set(id, t);

        for(const l of this.listeners)
          if(l.timerTick) l.timerTick(id, t);

        if(t === 0) {
          clearInterval(intId);
          this.stopTimer(id, err => {
            if(err) console.error(err);
          });
        }
      }, 1000);

      this.runningTimers.set(id, intId);

      for(const l of this.listeners)
        if(l.timerStarted) l.timerStarted(id, value);

      cb(null);
    });
  }

  startTimer(id, cb) {
    return this._startTimer(id, `timer:${id}:left`, cb);
  }

  restartTimer(id, cb) {
    return this._startTimer(id, `timer:${id}`, cb);
  }

  stopTimer(id, cb) {
    if(!this.runningTimers.has(id)) return cb('AlreadyStopped');
    const intId = this.runningTimers.get(id);

    // TODO: if stopTimer is called right after startTimer, this.timerValues[id] may be undefined

    this.db.put(`timer:${id}:left`, this.timerValues.get(id), (err) => {
      if(err) return cb(err);

      clearInterval(intId);
      this.runningTimers.delete(id);

      for(const l of this.listeners)
        if(l.timerStopped) l.timerStopped(id);

      cb(null);
    });
  }

  updateTimer(id, value, cb) {
    if(this.runningTimers.has(id)) return cb('TimerRunning');

    Promise.all([
      (resolve, reject) => this.db.put(`timer:${id}:left`, value, err => err ? reject(err) : resolve(err)),
      (resolve, reject) => this.db.put(`timer:${id}`, value, err => err ? reject(err) : resolve(err)),
    ].map(e => new Promise(e))).then(() => {
      for(const l of this.listeners)
        if(l.timerUpdated) l.timerUpdated(id, value);
      cb(null);
    }).catch(cb);
  }

  /**
   * Possible values for type:
   * - 'standalone': A standalone timer
   * - 'speaker': A timer for a speaker list, whose name must be identical to the list's id
   */

  addTimer(name, type, value, cb) {
    const id = crypto.randomBytes(16).toString('hex');

    this.db.get('timers', (err, timers) => {
      if(err) return cb(err);
      timers.unshift({ id, name, type });
      Promise.all([
        (resolve, reject) => this.db.put('timers', timers, err ? reject(err) : resolve(err)),
        (resolve, reject) => this.db.put(`timer:${id}`, value, err ? reject(err) : resolve(err)),
        (resolve, reject) => this.db.put(`timer:${id}:left`, value, err ? reject(err) : resolve(err)),
      ].map(e => new Promise(e))).then(() => {
        for(const l of this.listeners)
          if(l.timerAdded) l.timerAdded(id, name, type, value);
        return cb(null, id);
      }).catch(cb);
    });
  }

  listTimers() {
    return new Promise((resolve, reject) => this.db.get(`timers`, (err, timers) => {
      if(err) return reject(err);

      for(const timer of timers)
        if(this.runningTimers.has(timer.id)) {
          timer.left = this.timerValues.get(timer.id);
          timer.active = true;
        }

      const promises = timers.map(timer => (resolve, reject) => {
        this.db.get(`timer:${timer.id}`, (err, value) => {
          if(err) return reject(err);

          this.db.get(`timer:${timer.id}:left`, (err, left) => {
            if(err) return reject(err);

            timer.value = value;
            if(!timer.left) timer.left = left; // Respect running timers
            if(!timer.active) timer.active = false;

            return resolve(timer);
          });
        });
      }).map(e => new Promise(e));

      Promise.all(promises).then(resolve).catch(reject);
    }));
  }

  /* Seats */

  updateSeats(seats, cb) {
    this.db.put('seats', seats, (err) => {
      if(err) return cb(err);
      for(const l of this.listeners)
        if(l.seatsUpdated) l.seatsUpdated(seats);
      return cb();
    });
  }

  listSeats() {
    return new Promise((resolve, reject) => this.db.get('seats', (err, seats) => {
      if(err) return reject(err);
      else return resolve(seats);
    }));
  }

  /* Files */
  // TODO: add cache
  
  addFile(name, type, content, cb) {
    const id = crypto.randomBytes(16).toString('hex');
    
    Promise.all([
      (resolve, reject) => {
        this.db.get('files', (err, files) => {
          if(err) return reject(err);
          files.unshift({ id, name, type });
          this.db.put('files', files, err ? reject(err) : resolve(err));
        });
      },
      (resolve, reject) => fs.writeFile(`${this.fileRoot}/${id}`, content, err => err ? reject(err) : resolve()),
    ].map(e => new Promise(e))).then(() => {
      for(const l of this.listeners)
        if(l.fileAdded) l.fileAdded(id, name, type);
      return cb(null, id)
    }).catch((err) => {
      console.log(err);
      cb(err);
    });
  }

  editFile(id, content, cb) {
    return fs.writeFile(`${this.fileRoot}/${id}`, content, (err) => {
      if(err) return cb(err);
      for(const l of this.listeners)
        if(l.fileEdited) l.fileEdited(id);
      return cb();
    });
  }

  getFile(id, cb) {
    return fs.readFile(`${this.fileRoot}/${id}`, cb);
  }

  listFiles() {
    return new Promise((resolve, reject) => this.db.get('files', (err, files) => {
      if(err) return reject(err);
      else return resolve(files);
    }));
  }

  /* Votes */
  /**
   * vote:${id}:matrix -> vote can have the following values:
   * 0: pass / didn't vote
   * -1: abstained
   * -2: negative
   * 1: positive
   */

  addVote(name, rounds, target, seats, cb) {
    const id = crypto.randomBytes(16).toString('hex');
    const matrix = seats.map(e => ({ name: e, vote: 0 }));

    Promise.all([
      (resolve, reject) => this.db.get('votes', (err, votes) => {
        if(err) return reject(err);
        votes.unshift({ id, name, target, rounds });
        this.db.put(`votes`, votes, err => err ? reject(err) : resolve());
      }),
      (resolve, reject) => this.db.put(`vote:${id}:status`, { iteration: 0, running: false }, err => err ? reject(err) : resolve()),
      (resolve, reject) => this.db.put(`vote:${id}:matrix`, matrix, err => err ? reject(err) : resolve()),
    ].map(e => new Promise(e))).then(() => {
      for(const l of this.listeners)
        if(l.voteAdded) l.voteAdded(id, name, rounds, target, seats);
      return cb(null, id);
    }).catch(cb);
  }

  updateVote(id, index, vote, cb) {
    this.db.get(`vote:${id}:matrix`, (err, matrix) => {
      if(err) return cb(err);

      matrix[index].vote = vote;
      this.db.put(`vote:${id}:matrix`, matrix, (err) => {
        if(err) return cb(err);

        for(const l of this.listeners)
          if(l.voteUpdated) l.voteUpdated(id, index, vote);
        return cb(null);
      });
    });
  }

  iterateVote(id, status, cb) {
    this.db.put(`vote:${id}:status`, status, err => {
      if(err) return cb(err);

      for(const l of this.listeners)
        if(l.voteIterated) l.voteIterated(id, status);
      return cb(null);
    });
  }
  
  listVotes() {
    return new Promise((resolve, reject) => {
      this.db.get('votes', (err, votes) => {
        if(err) return reject(err);

        const promises = votes.map(vote => Promise.all([
          new Promise((resolve, reject) => this.db.get(`vote:${vote.id}:status`, (err, status) => err ? reject(err) : resolve(status))),
          new Promise((resolve, reject) => this.db.get(`vote:${vote.id}:matrix`, (err, matrix) => err ? reject(err) : resolve(matrix))),
        ]).then(([ status, matrix ]) => ({
          id: vote.id,
          name: vote.name,
          status,
          matrix,
        })));

        Promise.all(promises).then(resolve).catch(reject);
      });
    });
  }

  fetchAll(cb) {
    Promise.all([
      this.listTimers(),
      this.listSeats(),
      this.listFiles(),
      this.listVotes(),
    ]).then(([timers, seats, files, votes]) => {
      cb(null, { timers, seats, files, votes })
    }).catch(cb);
  }

  addListener(listener) {
    this.listeners.push(listener);
  }
}

module.exports = Conference;
