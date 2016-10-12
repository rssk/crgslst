const config = require('../config.json');
const nodemailer = require('nodemailer');
const Bluebird = require('Bluebird');
const redis = require('redis');
const longList = (require('./data/citylist-long.json'));
const shortList = (require('./data/citylist-short.json'));
const writeAsync = Bluebird.promisify(require('fs').writeFile);
const _ = require('lodash');
const request = require('request-promise');
Bluebird.promisifyAll(redis.RedisClient.prototype);
Bluebird.promisifyAll(redis.Multi.prototype);
const cheerio = require('cheerio');
// const CronJob = require('cron').CronJob;
const randomUA = require('random-ua');
// const cities = _.shuffle(require('./citylist-short.json'));
// const zipcodes = require('zipcodes');

/**
* returns a random range of milliseconds, crazy
* @param  {integer} low  lower bound
* @param  {integer} high upper bound
* @return {integer}      random millisecond
*/
const randomMilliseconds = (low, high) => Math.floor(Math.random() * (high - low + 1) + low);

class nodeslist {
  constructor(opts) {
    const options = opts || {};
    this.adapter = options.adapter || config.db.adapter;
    this.config = config;
    this.cities = {};
    this.cities.long = longList;
    this.cities.short = shortList;

    if (this.adapter === 'file') {
      // file
    } else if (this.adapter === 'redis') {
      this.db = redis.createClient();
    }
  }

  /**
  * write data using setup db adapter
  * @param  {string} data listing data
  * @return {Promise}     database write fulfilled Promise
  */
  save(data) {
    //TODO: abstract db writes for diff adapters
  }


  search(searchString, searchArea) {
    const searchCities = this.cities[searchArea] || this.cities.short;
    Bluebird.all(_.map(searchCities, (city, index) => {
      const mult = Math.log(index) + 1;
      return new Bluebird((resolve) => {
        setTimeout(() => {
          const options = {
            url: `http://${city}.org/${searchString}`,
            headers: {
              'User-Agent': randomUA.generate(),
            },
          };

          this.searchCity(city, options)
          .then((mail) => {
            resolve(mail);
          });
        }, randomMilliseconds(2500 * mult, 3000 * mult));
      });
    }))
    .then((results) => {
      let merged = [].concat.apply([], results);
      merged = _.sortBy(merged, (listing) => _.last(listing.split('$')));
      merged = _.uniq(merged);

      if (merged.length > 0) {
        this.notify(merged);
      } else {
        console.log('No new matches :-(!)');
        process.exit(2);
      }
    })
    .catch((err) => {
      console.log(`Failure: ${err}`);
    });
  }

  searchCity(city, options) {
    const mailQueue = [];
    return request(options)
    .then((body) => {
      const $ = cheerio.load(body);
      return this.db.smembersAsync(city)
      .then((listings) => {
        const promises = [];
        $('p.row').each((index, element) => {
          if (element.attribs['data-repost-of']) {
            const postID = element.attribs['data-repost-of'];
            const price = String($(element).find('span.price').html());
            const uri = $(element).find('a').attr('href');
            const dbRef = `${city}:${postID}:${uri}`;
            const finding = _.find(listings, (listing) => _.startsWith(listing, dbRef));

            if (finding) {
              const prevPrice = _.last(finding.split(':'));

              // old, did the price change?
              if (prevPrice !== price) {
                if (_.includes(uri, 'craigslist')) {
                  mailQueue.push(`changed! ${uri}  ${price}`);
                } else {
                  mailQueue.push(`changed! http://${city}.org${uri}  ${price}`);
                }

                promises.push(
                  this.db.sremAsync(city, finding)
                  .then(() => {
                    return this.db.saddAsync(
                      city,
                      `${dbRef}:${price}`
                    );
                  })
                );
              }
            } else {
              // new! add to mail
              if (_.includes(uri, 'craigslist')) {
                // near by results
                mailQueue.push(`new!        ${uri}   ${price}`);
              } else {
                mailQueue.push(`new!        http://${city}.org${uri}  ${price}`);
              }

              promises.push(this.db.saddAsync(city, `${dbRef}:${price}`));
            }
          } else {
            const postID = element.attribs['data-pid'];
            const price = String($(element).find('span.price').html());
            const uri = $(element).find('a').attr('href');
            const dbRef = `${city}:${postID}:${uri}`;
            const finding = _.find(listings, (listing) => _.startsWith(listing, dbRef));

            if (finding) {
              const prevPrice = _.last(finding.split(':'));

              // old, did the price change?
              if (prevPrice !== price) {
                if (_.includes(uri, 'craigslist')) {
                  mailQueue.push(`changed! ${uri}  ${price}`);
                } else {
                  mailQueue.push(`changed! http://${city}.org${uri}  ${price}`);
                }

                promises.push(
                  this.db.sremAsync(city, finding)
                  .then(() => {
                    return this.db.saddAsync(
                      city,
                      `${dbRef}:${price}`
                    );
                  })
                );
              }
            } else {
              // new! add to mail
              if (_.includes(uri, 'craigslist')) {
                // near by results
                mailQueue.push(`new!        ${uri}  ${price}`);
              } else {
                mailQueue.push(`new!        http://${city}.org${uri}  ${price}`);
              }

              promises.push(this.db.saddAsync(city, `${dbRef}:${price}`));
            }
          }
        });

        return Bluebird.all(promises)
        .then(() => mailQueue);
      });
    });
  }

  notify(output) {
    let filePromise;
    let mailPromise;

    if (this.config.output.file) {
      filePromise = writeAsync('./lastSearch.txt', output.join('\r\n')).reflect();
    }
    // TODO: promise this shit together
    if (this.config.output.email.service) {
      // email them bitches
      const transporter = nodemailer.createTransport({
        service: 'Mailgun',
        auth: {
          user: this.config.output.email.user,
          pass: this.config.output.email.password,
        },
      });
      const mailOptions = {
        from: this.config.output.email.from, // sender address
        to: this.config.output.email.to, // list of receivers
        subject: 'New craigslist matches!', // Subject line
        text: output.join('\r\n'), // plaintext body
      };

      mailPromise = transporter.sendMail(mailOptions).reflect();
    }

    Bluebird.all([
      filePromise,
      mailPromise,
    ]).each((inspection) => {
      if (inspection.isFulfilled()) {
        console.log('A promise in the array was fulfilled with', inspection.value());
      } else {
        console.error('A promise in the array was rejected with', inspection.reason());
      }
    }).then(() => {
      process.exit(0);
    });
  }
}

module.exports = nodeslist;
