'use strict';
const Nodeslist = require('./lib/nodeslist');

const nodeslist = new Nodeslist();

const searchString = process.argv[2];
nodeslist.search(searchString);
//     setTimeout(function() {
//         console.log('Timmemsmemsms');
// new CronJob('0 * * * * *', function() {
//     }, randomMilliseconds(0, 900000));
// }, null, true, 'America/Shiprock');
