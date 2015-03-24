/*
TODO:
uniquify on track (multiple incarnations of same artist)
*/

var fs = require('fs');
var Q = require('q');
var request = require('request');
var restify = require('restify');
var mysql = require('mysql2');
var requireDir = require('require-dir');
var configFiles = requireDir('./config');

var config = {};
var fileNames = Object.keys(configFiles);
fileNames.sort();
fileNames.forEach(function(fileName) {
    var configObj = configFiles[fileName];
    for (var attrname in configObj) { config[attrname] = configObj[attrname]; }
});

var pool = mysql.createPool(config.MYSQL);

pool.boundQuery = function() {
    var deferred = Q.defer();
    var qArgs = Array.prototype.slice.call(arguments, 0);
    var cb = function(err, connection) {
	    if (err) {
	        deferred.reject(err);
	    } else {
	        qArgs.push(function(err, rows) {
		        if (err) {
		            deferred.reject(err);
		        } else {
		            deferred.resolve(rows);
		        }
		        connection.release();
	        });
	        connection.query.apply(connection, qArgs);
	    }
    }
    pool.getConnection(cb);
    return deferred.promise;
};

function mysqlStore(pool, table) {
    var sql = 'CREATE TABLE IF NOT EXISTS '+table+' (k VARCHAR(255) PRIMARY KEY, v VARCHAR(21000)) ENGINE=innodb'
    return pool.boundQuery(sql).then(function () {
	    var openRequests = {};
	    return {
	        'get': function(key) {
		        if (! openRequests[key]) {
		            openRequests[key] = pool.boundQuery('SELECT k,v FROM ' + table + ' WHERE k=? COLLATE utf8_general_ci', key).then(function(rows) {
			            if (rows.length == 0) return undefined;
			            ret = JSON.parse(rows[0].v);
                        return ret;
		            }).fin(function() {
			            delete openRequests[key];
		            });
		        }
		        return openRequests[key];
	        },
	        'iter': function(callback) {
		        var deferred = Q.defer();
		        var cb = function(err, conn) {
		            if (err) {
			            deferred.reject(err);
			            return;
		            }
		            var query = conn.query('SELECT k,v from ' + table);
		            var hadError = false;
		            query.on('error', function(err) {
			            hadError=true;
			            deferred.reject(err);
		            });
		            query.on('end', function() {
			            if (! hadError) deferred.resolve();
			            conn.release();
		            });
		            query.on('result', function(row) {
			            conn.pause();
			            Q.fcall(callback, row.k, row.v).fin(function(){conn.resume();}).done();
		            });
		        };
		        pool.getConnection(cb);
		        return deferred.promise;
	        },
	        'set': function(key, val) {
		        var sql = 'INSERT INTO ' + table + ' (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)';
		        return pool.boundQuery(sql, [key, JSON.stringify(val)]);
	        }
	    };
    });
}

function http(options) {
    options.encoding = 'utf8';
    var deferred = Q.defer();
    request(options, function(err, httpResponse, body) {
	if (err) {
	    deferred.reject(err);
	} else {
	    deferred.resolve(body);
	}
    });
    return deferred.promise;
}

function formatDate(dt) {
    return dt.toISOString().substring(0, 19);
}

function fetchEvents(opts, range) {
    var zipcode = opts.zipcode;
    var latlon = opts.latlon;
    var daysout = opts.daysout;
    var maxmiles = opts.maxmiles;
    range = (range > maxmiles) ? maxmiles : range;
    var dt = new Date();
    var startdt = formatDate(new Date(dt.getTime() - 2 * 3600 * 1000));
    var enddt = formatDate(new Date(dt.getTime() + ((daysout - 1) * 24 - 2) * 3600 * 1000));

    console.log('input', zipcode, opts.clientIp, latlon, startdt, enddt);
    var promise;
    if (true) {
	var uri = 'http://api.bandsintown.com/events/search?app_id=musictonight.millstonecw.com&format=json&per_page=50';
	if (latlon) {
	    uri += '&location=' + latlon;
	} else {
	    if (opts.clientIp !== '127.0.0.1') {
		uri += '&location=' + opts.clientIp;
	    } else {
		uri += '&location=40.7436300,-73.9906270';
	    }
	}
	uri += '&radius=' + range;
	uri += '&date=' + startdt.substring(0, 10) + ',' + enddt.substring(0, 10);
	console.log(uri);
	promise = http({method:'get', uri:uri, json:true}).then(function(events) {
	    if (events.errors) {
		var errors = events.errors;
		if (errors[0] === 'Unknown Location') {
		    throw new Error('client error: cannot_geo_ip');
		} else {
		    throw new Error(events.errors);
		}
	    }
	    events.forEach(function(event) {
		event.timestring = event.datetime.substring(11,16);
		event.datetime_local = event.datetime;
		event.performers = event.artists;
		delete event.artists;
	    });
	    return events;
	});
    } else {
	var uri = config.SEATGEEK_EVENTS_PREFIX + '&taxonomies.name=concert&sort=score.desc&per_page=50&range='+range+'mi&datetime_utc.gte='+startdt+'&datetime_utc.lt='+enddt;
	if (latlon) {
	    var parts = latlon.split(',');
	    uri += '&lat=' + parts[0] + '&lon=' + parts[1];
	} else {
	    var geoip = (zipcode !== undefined && zipcode !== '00000') ? zipcode : opts.clientIp;
	    uri += '&geoip=' + geoip;
	}
	promise = http({method:'get', uri:uri, json:true}).then(function(response) {
	    response.events.forEach(function(event) {
		event.timestring = '';
		if (event.datetime_local) {
		    event.timestring = event.datetime_local.substring(11,16);
		}
	    });
	    return response.events;
	});
    }
    return promise.then(function(events) {
	var num_events = events.length;
	var target_count = Math.min(50, Math.max(4, Math.round(600 / range)));
	console.log('results at range ', range, ' : ', num_events, ' (target is:', target_count, ')');
	if (range >= maxmiles || num_events >= target_count) {
	    var performer_map = {};
	    events.forEach(function(event) {
		event.timestring = '';
		if (event.datetime_local) {
		    event.timestring = event.datetime_local.substring(11,16);
		}
		event.performers.forEach(function(performer) {
		    performer_map[performer.name]=event;
		});
	    });
	    return performer_map;
	} else {
	    var multiplier = Math.sqrt((target_count + 1) / (num_events + 1));
	    if (multiplier < 1.1) { multiplier = 1.1; }
	    if (multiplier > 2.0) { multiplier = 2.0; }
	    return fetchEvents(opts, 1 + Math.ceil(range * multiplier));
	}
    });
}

hashCode = function(string) {
  var hash = 0, i, chr, len;
  if (string.length == 0) return hash;
  for (i = 0, len = string.length; i < len; i++) {
    chr   = string.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

function spotifyArtist(performer) {
    var uri = config.SPOTIFY_ARTIST_SEARCH_PREFIX + 'limit=5&q='+encodeURIComponent('"'+performer+'"');
    return http({uri:uri, method:'get', json:true}).then(
	function(response) {
	    var artists = response.artists.items;
	    if (artists.length == 0) {
		console.log('no artists found for: '+performer);
		return null;
	    }
	    artists = artists.filter(function(artist) { return artist.name === performer });
	    if (artists.length == 0) {
		console.log('no name match for artist: '+performer);
		return null;
	    }
	    return artists[0];
	}
    ).then(
	function(artist) {
	    if (artist === null) return null;
	    uri = config.SPOTIFY_ARTIST_PREFIX + artist.id+'/top-tracks?country=US';
	    return http({uri:uri, method:'get', json:true}).then(function(tracks_response) {
		var tracks = tracks_response.tracks;
		if (tracks.length === 0) {
		    console.log('no tracks for artist: '+performer);
		    return null;
		}
		function score_track(t) { return (t.popularity + 10.0) / (t.artists.length * t.artists.length); }
		tracks.sort(function(a,b) {return score_track(b) - score_track(a);});
		tracks = tracks.slice(0, 5);
		tracks = tracks.map(function(item) {
		    return {name: item.name, artist: performer, uri: item.uri, popularity: item.popularity};
		});
		artist.tracks = tracks;
		return artist;
	    });
	}
    );
}

function getMusic(eventOptions, trackOptions, artistStore) {
    var maxTracksPerArtist = trackOptions.maxTracksPerArtist;
    return fetchEvents(eventOptions, 2).then(function(performer_map) {
	var playlistName = formatDate(new Date()).substring(0, 10) + '-music-tonight';
	var performers = Object.keys(performer_map);
	var tracksPerArtist = Math.round(22.0 / performers.length);
	tracksPerArtist = Math.max(1, Math.min(maxTracksPerArtist, tracksPerArtist));
	var promises = performers.map(function(performer) {
	    return artistStore.get(performer).then(function(data) {
		if (data) {
		    return JSON.parse(data);
		} else {
		    return spotifyArtist(performer).then(function(result){
			artistStore.set(performer, JSON.stringify(result)).done();
			return result;
		    });
		}
	    }).then(function(artist){
		if (artist === null) { return null; }
		artist.tracks.forEach(function(track) {
		    track.event = performer_map[performer];
		    if (track.name.split(' ').length > 6) {
			track.name = track.name.split(' ', 6).join(' ') + '...';
		    }
		});
		return artist.tracks.slice(0, tracksPerArtist);
	    });
	});
	return Q.all(promises).then(function(track_data) {
	    var tracks = [];
	    track_data.forEach(function(result) {
		if (result) {
		    result.forEach(function(track){ tracks.push(track); });
		}
	    });
	    return {name: playlistName, tracks:tracks};
	});
    });
}

function promised(fn) {
    return function(req, res, next) {
	fn(req, res, next).then(function(result) {
	    res.send(200, result);
	}, function(err) {
	    console.log('returning error', err);
	    if ((err+'').match(/client error/)) {
		res.send(400, err);
	    } else {
		console.log(err.stack);
		res.send(500, err);
	    }
	}).done();
    };
}

function clientError(desc) {
    throw new Error('client error: ' + desc);
}

function makeServer(artistStore) {
    
    server = restify.createServer();
    
    server.on('uncaughtException', function(req, res, route, err) {
	console.log(err.stack);
	res.send(err);
    });
    
    server.use(restify.queryParser());
    server.use(restify.gzipResponse());
    
    server.use( // CORS
	function crossOrigin(req,res,next){
	    res.header("Access-Control-Allow-Origin", "*");
	    res.header("Access-Control-Allow-Headers", "X-Requested-With");
	    return next();
	}
    );

    server.get('/api/playlist', promised(function(req, res) {
	console.log('get playlist', req.params);
	var clientIp = req.headers['x-forwarded-for'] || 
	    req.connection.remoteAddress || 
	    req.socket.remoteAddress ||
	    req.connection.socket.remoteAddress;

	var language = 'en-US';
	var acceptLanguages = req.headers['accept-language'];
	if (acceptLanguages) {
	    language = acceptLanguages.split(/[\,\;]/)[0];
	}

	var daysout = (req.params.daysout) ? parseInt(req.params.daysout) : 1;
	var maxmiles = (req.params.maxmiles) ? parseInt(req.params.maxmiles) : 125;
	var eventOptions = {
	    zipcode: req.params.zip_code,
	    clientIp: clientIp,
	    latlon: req.params.latlon,
	    daysout: daysout,
	    maxmiles: maxmiles
	};
	var trackOptions = {
	    maxTracksPerArtist: (req.params.maxartisttracks) ? parseInt(req.params.maxartisttracks) : 2
	};
	return getMusic(eventOptions, trackOptions, artistStore).then(function(result) {
	    result.language = language;
	    return result;
	});
    }));

    return server;
}

mysqlStore(pool, 'artists').then(function(artistStore) {
    var server = makeServer(artistStore);
    server.listen(11809, function() {
	console.log('%s listening at %s', server.name, server.url);
    });
}).done();
