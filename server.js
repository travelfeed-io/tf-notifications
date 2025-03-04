const _ = require('lodash');
const express = require('express');
const SocketServer = require('ws').Server;
const { Client } = require('busyjs');
const bodyParser = require('body-parser');
const redis = require('./helpers/redis');
const utils = require('./helpers/utils');
const router = require('./routes');
const notificationUtils = require('./helpers/expoNotifications');

const NOTIFICATION_EXPIRY = 5 * 24 * 3600;
const LIMIT = 25;

const app = express();
app.use(bodyParser.json());
app.use('/', router);

const port = process.env.PORT || 5000;
const server = app.listen(port, () => console.log(`Listening on ${port}`));

const wss = new SocketServer({ server });

const steemdWsUrl = process.env.STEEMD_WS_URL || 'https://anyx.io/';
const client = new Client(steemdWsUrl);

const cache = {};
const useCache = false;

const clearGC = () => {
  try {
    global.gc();
  } catch (e) {
    console.log("You must run program with 'node --expose-gc index.js' or 'npm start'");
  }
};

setInterval(clearGC, 60 * 1000);

/** Init websocket server */

wss.on('connection', ws => {
  console.log('Got connection from new peer');
  ws.on('message', message => {
    console.log('Message', message);
    let call = {};
    try {
      call = JSON.parse(message);
    } catch (e) {
      console.error('Error WS parse JSON message', message, e);
    }
    // const key = new Buffer(JSON.stringify([call.method, call.params])).toString('base64');
    if (call.method === 'get_notifications' && call.params && call.params[0]) {
      redis
        .lrangeAsync(`notifications:${call.params[0]}`, 0, -1)
        .then(res => {
          console.log('Send notifications', call.params[0], res.length);
          const notifications = res.map(notification => JSON.parse(notification));
          ws.send(JSON.stringify({ id: call.id, result: notifications }));
        })
        .catch(err => {
          console.log('Redis get_notifications failed', err);
        });
      // } else if (useCache && cache[key]) {
      //  ws.send(JSON.stringify({ id: call.id, cache: true, result: cache[key] }));
    } else if (call.method === 'subscribe' && call.params && call.params[0]) {
      console.log('Subscribe success', call.params[0]);
      ws.name = call.params[0];
      ws.send(
        JSON.stringify({ id: call.id, result: { subscribe: true, username: call.params[0] } }),
      );
    } else if (call.method && call.params) {
      client.call(call.method, call.params, (err, result) => {
        ws.send(JSON.stringify({ id: call.id, result }));
        // if (useCache) {
        //  cache[key] = result;
        // }
      });
    } else {
      ws.send(
        JSON.stringify({
          id: call.id,
          result: {},
          error: 'Something is wrong',
        }),
      );
    }
  });
  ws.on('error', () => console.log('Error on connection with peer'));
  ws.on('close', () => console.log('Connection with peer closed'));
});

/** Stream the blockchain for notifications */

const getNotifications = ops => {
  const notifications = [];
  ops.forEach(op => {
    const type = op.op[0];
    const params = op.op[1];
    // Filter out non-TravelFeed posts
    if (params.json_metadata) {
      data = JSON.parse(params.json_metadata);
      if (data && data['tags'] && data['tags'].indexOf('travelfeed') === -1) {
        return;
      }
    }
    switch (type) {
      case 'comment': {
        const isRootPost = !params.parent_author;
        /** Find replies */
        if (!isRootPost) {
          const notification = {
            type: 'reply',
            parent_permlink: params.parent_permlink,
            author: params.author,
            permlink: params.permlink,
            timestamp: Date.parse(op.timestamp) / 1000,
            block: op.block,
          };
          notifications.push([params.parent_author, notification]);
        }

        /** Find mentions */
        const pattern = /(@[a-z][-\.a-z\d]+[a-z\d])/gi;
        const content = `${params.title} ${params.body}`;
        const mentions = _.without(
          _.uniq(
            (content.match(pattern) || [])
              .join('@')
              .toLowerCase()
              .split('@'),
          ).filter(n => n),
          params.author,
        ).slice(0, 9); // Handle maximum 10 mentions per post
        if (mentions.length) {
          mentions.forEach(mention => {
            const notification = {
              type: 'mention',
              is_root_post: isRootPost,
              author: params.author,
              permlink: params.permlink,
              timestamp: Date.parse(op.timestamp) / 1000,
              block: op.block,
            };
            notifications.push([mention, notification]);
          });
        }
        break;
      }
      case 'custom_json': {
        let json = {};
        try {
          json = JSON.parse(params.json);
        } catch (err) {
          console.log('Wrong json format on custom_json', err);
        }
        switch (params.id) {
          case 'follow': {
            /** Find follow */
            if (
              json[0] === 'follow' &&
              json[1].follower &&
              json[1].following &&
              _.has(json, '[1].what[0]') &&
              json[1].what[0] === 'blog'
            ) {
              const notification = {
                type: 'follow',
                follower: json[1].follower,
                timestamp: Date.parse(op.timestamp) / 1000,
                block: op.block,
              };
              notifications.push([json[1].following, notification]);
            }
            break;
          }
        }
        break;
      }
      case 'vote': {
        // Only notify on votes by @travelfeed
        if (params.voter !== 'travelfeed') return;
        /** Find downvote */
        const notification = {
          type: 'vote',
          voter: params.voter,
          permlink: params.permlink,
          weight: params.weight,
          timestamp: Date.parse(op.timestamp) / 1000,
          block: op.block,
        };
        // console.log('Downvote', JSON.stringify([params.author, notification]));
        notifications.push([params.author, notification]);
        break;
      }
    }
  });
  return notifications;
};

const loadBlock = blockNum => {
  utils
    .getOpsInBlock(blockNum, false)
    .then(ops => {
      if (!ops.length) {
        console.error('Block does not exit?', blockNum);
        utils
          .getBlock(blockNum)
          .then(block => {
            if (block && block.previous && block.transactions.length === 0) {
              console.log('Block exist and is empty, load next', blockNum);
              redis
                .setAsync('last_block_num', blockNum)
                .then(() => {
                  loadNextBlock();
                })
                .catch(err => {
                  console.error('Redis set last_block_num failed', err);
                  loadBlock(blockNum);
                });
            } else {
              console.log('Sleep and retry', blockNum);
              utils.sleep(2000).then(() => {
                loadBlock(blockNum);
              });
            }
          })
          .catch(err => {
            console.log(
              'Error lightrpc (getBlock), sleep and retry',
              blockNum,
              JSON.stringify(err),
            );
            utils.sleep(2000).then(() => {
              loadBlock(blockNum);
            });
          });
      } else {
        const notifications = getNotifications(ops);
        /** Create redis operations array */
        const redisOps = [];
        notifications.forEach(notification => {
          const key = `notifications:${notification[0]}`;
          redisOps.push(['lpush', key, JSON.stringify(notification[1])]);
          redisOps.push(['expire', key, NOTIFICATION_EXPIRY]);
          redisOps.push(['ltrim', key, 0, LIMIT - 1]);
        });
        redisOps.push(['set', 'last_block_num', blockNum]);
        redis
          .multi(redisOps)
          .execAsync()
          .then(() => {
            console.log('Block loaded', blockNum, 'notification stored', notifications.length);

            /** Send push notification for logged peers */
            notifications.forEach(notification => {
              wss.clients.forEach(client => {
                if (client.name && client.name === notification[0]) {
                  console.log('Send push notification', notification[0]);
                  client.send(
                    JSON.stringify({
                      type: 'notification',
                      notification: notification[1],
                    }),
                  );
                }
              });
            });
            /** Send notifications to all devices */
            notificationUtils.sendAllNotifications(notifications);
            loadNextBlock();
          })
          .catch(err => {
            console.error('Redis store notification multi failed', err);
            loadBlock(blockNum);
          });
      }
    })
    .catch(err => {
      console.error('Call failed with lightrpc (getOpsInBlock)', err);
      console.log('Retry', blockNum);
      loadBlock(blockNum);
    });
};

const loadNextBlock = () => {
  redis
    .getAsync('last_block_num')
    .then(res => {
      let nextBlockNum = res === null ? 36916135 : parseInt(res) + 1;
      utils
        .getGlobalProps()
        .then(globalProps => {
          const lastIrreversibleBlockNum = globalProps.last_irreversible_block_num;
          if (lastIrreversibleBlockNum >= nextBlockNum) {
            loadBlock(nextBlockNum);
          } else {
            utils.sleep(2000).then(() => {
              console.log(
                'Waiting to be on the lastIrreversibleBlockNum',
                lastIrreversibleBlockNum,
                'now nextBlockNum',
                nextBlockNum,
              );
              loadNextBlock();
            });
          }
        })
        .catch(err => {
          console.error('Call failed with lightrpc (getGlobalProps)', err);
          utils.sleep(2000).then(() => {
            console.log('Retry loadNextBlock', nextBlockNum);
            loadNextBlock();
          });
        });
    })
    .catch(err => {
      console.error('Redis get last_block_num failed', err);
    });
};

const start = () => {
  console.info('Start streaming blockchain');
  loadNextBlock();

  /** Send heartbeat to peers */
  setInterval(() => {
    wss.clients.forEach(client => {
      client.send(JSON.stringify({ type: 'heartbeat' }));
    });
  }, 20 * 1000);
};

// redis.flushallAsync();
start();
