const axios = require('axios');
const logger = require('./logger');

class BuildTimeoutReporter {
  constructor(build) {
    this._build = build;
  }

  reportBuildTimeout() {
    return Promise.all([
      this._sendBuildLogRequest(),
      this._sendBuildStatusRequest(),
    ]).catch((err) => {
      logger.error('Error reporting timeout for build %s: %s', this._build.federalistBuildId(), err);
    });
  }

  _request(url, json) {
    return axios.post(url, json);
  }

  _sendBuildLogRequest() {
    const url = this._build.containerEnvironment.LOG_CALLBACK;
    logger.verbose(`Sending timeout log request for build ${this._build.federalistBuildId()}`);
    return this._request(url, {
      output: Buffer.from('The build timed out').toString('base64'),
      source: 'Build scheduler',
    });
  }

  _sendBuildStatusRequest() {
    const url = this._build.containerEnvironment.STATUS_CALLBACK;
    logger.verbose(`Sending timeout status request for build ${this._build.federalistBuildId()}`);
    return this._request(url, {
      message: Buffer.from('The build timed out').toString('base64'),
      status: 'error',
    });
  }
}

module.exports = BuildTimeoutReporter;
