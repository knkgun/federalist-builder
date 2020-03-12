const { expect } = require('chai');
const nock = require('nock');
const url = require('url');

const Cluster = require('../src/cluster');
const Build = require('../src/build');

const mockBuildLogCallback = require('./nocks/build-log-callback-nock');
const mockBuildStatusCallback = require('./nocks/build-status-callback-nock');
const mockListAppsRequest = require('./nocks/cloud-foundry-list-apps-nock');
const mockListAppStatsRequest = require('./nocks/cloud-foundry-list-app-stats-nock');
const mockRestageAppRequest = require('./nocks/cloud-foundry-restage-app-nock');
const mockTokenRequest = require('./nocks/cloud-foundry-oauth-token-nock');
const mockUpdateAppRequest = require('./nocks/cloud-foundry-update-app-nock');

function mockContainers(num) {
  mockListAppsRequest(Array(num).fill({}));

  for (let i = 0; i < num; i += 1) {
    mockListAppStatsRequest('123abc', { 0: { state: 'RUNNING' } });
  }
}

describe('Cluster', () => {
  const logCallbackURL = url.parse('https://www.example.gov/log');
  const statusCallbackURL = url.parse('https://www.example.gov/status');
  let logCallbackNock;
  let statusCallbackNock;

  beforeEach(() => {
    logCallbackNock = mockBuildLogCallback(logCallbackURL);
    statusCallbackNock = mockBuildStatusCallback(statusCallbackURL);
  });

  afterEach(() => {
    process.env.BUILD_TIMEOUT_SECONDS = undefined;
    nock.cleanAll();
  });

  describe('._countAvailableContainers()', () => {
    it('should return the number of available containers', (done) => {
      const numContainers = 10;

      mockTokenRequest();
      mockContainers(numContainers);

      const cluster = new Cluster();
      cluster.start();

      setTimeout(() => {
        expect(cluster._countAvailableContainers()).to.eq(numContainers);
        done();
      }, 50);
    });
  });

  describe('.startBuild(build)', () => {
    it('should update and restage a container', (done) => {
      mockTokenRequest();
      mockListAppsRequest([{}]);

      const mockedUpdateRequest = mockUpdateAppRequest();
      const mockedRestageRequest = mockRestageAppRequest();

      const cluster = new Cluster();
      cluster.start();

      setTimeout(() => {
        cluster.startBuild({
          buildID: '123abc',
          containerEnvironment: {},
        });
        setTimeout(() => {
          expect(mockedUpdateRequest.isDone()).to.eq(true);
          expect(mockedRestageRequest.isDone()).to.eq(true);
          done();
        }, 50);
      }, 50);
    });

    it('should reduce the number of available containers by 1', (done) => {
      mockTokenRequest();
      mockListAppsRequest([{}]);
      mockUpdateAppRequest();
      mockRestageAppRequest();

      const cluster = new Cluster();
      cluster.start();

      setTimeout(() => {
        expect(cluster._countAvailableContainers()).to.eq(1);
        cluster.startBuild({
          buildID: '123abc',
          containerEnvironment: {},
        });
        setTimeout(() => {
          expect(cluster._countAvailableContainers()).to.eq(0);
          done();
        }, 50);
      }, 50);
    });

    it('should not reduce the number of containers by 1 if it fails to start the build', (done) => {
      mockTokenRequest();
      mockListAppsRequest([{ guid: 'fake-container' }]);
      mockUpdateAppRequest();

      nock('https://api.example.com').post(
        '/v2/apps/fake-container/restage'
      ).reply(500);

      const cluster = new Cluster();
      cluster.start();

      setTimeout(() => {
        expect(cluster._countAvailableContainers()).to.eq(1);
        cluster.startBuild({
          buildID: '123abc',
          containerEnvironment: {},
        }).catch(() => {
          // This promise rejects, but we're not testing this right now
          // Adding the catch to make sure all promise rejections are handled
        });
        setTimeout(() => {
          expect(cluster._countAvailableContainers()).to.eq(1);
          done();
        }, 50);
      }, 50);
    });

    it('should stop the build after the timeout has been exceeded', (done) => {
      mockTokenRequest();
      mockListAppsRequest([{ guid: '123abc' }]);
      mockListAppStatsRequest('123abc', { 0: { state: 'RUNNING' } });
      mockUpdateAppRequest();
      mockRestageAppRequest();

      process.env.BUILD_TIMEOUT_SECONDS = -1;

      const sqsMessage = {
        Body: JSON.stringify({
          environment: [
            { name: 'LOG_CALLBACK', value: logCallbackURL.href },
            { name: 'STATUS_CALLBACK', value: statusCallbackURL.href },
            { name: 'BUILD_ID', value: '456def' },
          ],
          name: 'Conatiner Name',
        }),
      };
      const build = new Build(sqsMessage);
      const buildID = build.buildID;

      const cluster = new Cluster();
      cluster.stopBuild = () => {
        expect(build.buildID).to.equal(buildID);
        expect(build.containerEnvironment.BUILD_ID).to.equal('456def');
        done();
      };
      cluster.start();

      setTimeout(() => {
        cluster.startBuild(build);
      }, 50);
    });

    it("should send a request to the build's log and status callback when the build timesout", (done) => {
      mockTokenRequest();
      mockListAppsRequest([{}]);
      mockUpdateAppRequest();
      mockRestageAppRequest();

      process.env.BUILD_TIMEOUT_SECONDS = -1;

      const cluster = new Cluster();
      cluster.start();

      const sqsMessage = {
        Body: JSON.stringify({
          environment: [
            { name: 'LOG_CALLBACK', value: logCallbackURL.href },
            { name: 'STATUS_CALLBACK', value: statusCallbackURL.href },
            { name: 'BUILD_ID', value: '123abc' },
          ],
          name: 'Conatiner Name',
        }),
      };
      const build = new Build(sqsMessage);

      setTimeout(() => {
        cluster.startBuild(build);
        setTimeout(() => {
          expect(logCallbackNock.isDone()).to.be.true;
          expect(statusCallbackNock.isDone()).to.be.true;
          done();
        }, 200);
      }, 50);
    });
  });

  describe('.stopBuild(buildID)', () => {
    it('should make the build for the given buildID available', () => {
      const cluster = new Cluster();
      const sqsMessage = {
        Body: JSON.stringify({
          environment: [
            { name: 'LOG_CALLBACK', value: logCallbackURL.href },
            { name: 'STATUS_CALLBACK', value: statusCallbackURL.href },
            { name: 'BUILD_ID', value: 'fed654' },
          ],
          name: 'Conatiner Name',
        }),
      };
      const build = new Build(sqsMessage);

      cluster._containers = [
        {
          guid: '123abc',
          build,
        },
        {
          guid: '789ghi',
          build: undefined,
        },
      ];

      cluster.stopBuild(build);

      const container = cluster._containers.find(c => c.guid === '123abc');

      expect(container).to.be.a('object');
      expect(container.build).to.be.undefined;
    });

    it("should not send a request to the build's log and status callback", (done) => {
      const cluster = new Cluster();
      const sqsMessage = {
        Body: JSON.stringify({
          environment: [
            { name: 'LOG_CALLBACK', value: logCallbackURL.href },
            { name: 'STATUS_CALLBACK', value: statusCallbackURL.href },
            { name: 'BUILD_ID', value: 'fed654' },
          ],
          name: 'Conatiner Name',
        }),
      };
      const build = new Build(sqsMessage);
      cluster._containers = [
        {
          guid: '123abc',
          build,
        },
      ];

      cluster.stopBuild(build);

      setTimeout(() => {
        expect(logCallbackNock.isDone()).to.be.false;
        expect(statusCallbackNock.isDone()).to.be.false;
        done();
      }, 200);
    });
  });

  describe('.canStartBuild()', () => {
    it('returns true if there are available containers', (done) => {
      mockTokenRequest();
      mockContainers(1);

      const cluster = new Cluster();
      cluster.start();

      setTimeout(() => {
        expect(cluster.canStartBuild()).to.be.true;
        done();
      }, 50);
    });

    it('returns false if there are no available containers', (done) => {
      mockTokenRequest();
      mockContainers(0);

      const cluster = new Cluster();
      cluster.start();

      setTimeout(() => {
        expect(cluster.canStartBuild()).to.be.false;
        done();
      }, 50);
    });
  });
});
