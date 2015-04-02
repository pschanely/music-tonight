'use strict';

/*
TODO:
uniquify on track (multiple incarnations of same artist)
*/

var fs = require('fs');
var Q = require('q');
var rdiolib = require('rdio');
var request = require('request');
var restify = require('restify');
var mysql = require('mysql2');
var url = require('url');
var cookieparser = require('restify-cookies');
var requireDir = require('require-dir');
var uuid = require('node-uuid');
var configFiles = requireDir('./config');


var os = require('os');

function getLocalIps() {
    var ifaces = os.networkInterfaces();
    var addrs = [];
    Object.keys(ifaces).forEach(function (ifname) {
	var alias = 0;
	ifaces[ifname].forEach(function (iface) {
	    if ('IPv4' !== iface.family || iface.internal !== false) {
		// skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
		return;
	    }
	    // this interface has only one ipv4 adress
	    addrs.push(iface.address);
	});
    });
    return addrs;
}


var config = {};
var fileNames = Object.keys(configFiles);
fileNames.sort();
fileNames.forEach(function(fileName) {
    var configObj = configFiles[fileName];
    for (var attrname in configObj) { config[attrname] = configObj[attrname]; }
});

getLocalIps().forEach(function(ip) {
    var host = config.HOST_PREFIXES[ip];
    if (host) {
	config.HOST_PREFIX = host;
    }
});
console.log('My host prefix is ', config.HOST_PREFIX);

config.RDIO.callback_url = config.HOST_PREFIX + config.RDIO.callback_url;
config.SPOTIFY.callback_url = config.HOST_PREFIX + '/api/music_svc_callback';

var rdio = rdiolib(config.RDIO);
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
			var ret = JSON.parse(rows[0].v);
                        return ret;
		    }).fin(function() {
			delete openRequests[key];
		    });
		}
		return openRequests[key];
	    },
	    'mget': function(keys) {
		if (keys.length === 0) return Q.fcall(function(){return {};});
		var clauses = keys.map(function(k){return 'k=?';}).join(' OR ');
		return pool.boundQuery('SELECT k,v FROM ' + table + ' WHERE '+clauses+' COLLATE utf8_general_ci', keys).then(function(rows) {
		    var result = {};
		    rows.forEach(function(row){result[row.k] = JSON.parse(row.v);});
		    return result;
		});
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

function clientCookie(req, res) {
    var myKey = req.cookies.svc_auth_key;
    console.log('client cookie ', myKey);
    if (! myKey) {
        myKey = uuid.v4();
        res.setCookie('svc_auth_key', myKey);
	console.log('client cookie set ', myKey);
    }
    return myKey;
}

function fetchUserInfo(authStore, myKey) {
    return authStore.get(myKey).then(function(info) {
	if (! info) {
	    info = {};
	}
	if (! info.div) {
	    info.div = {};
	}
	return info;
    });
}

function titlePlaylist() {
    return formatDate(new Date()).substring(0,10) + '-music-tonight';
}

function parse_hash_query(url) {
    var args = {};
    var hash = url.replace(/^[^\#]*#/g, '');
    var all = hash.split('&');
    all.forEach(function(keyvalue) {
	var idx = keyvalue.indexOf('=');
	var key = keyvalue.substring(0, idx);
	var val = keyvalue.substring(idx + 1);
	args[key] = val;
    });
    return args;
}

function getDiversityChecker(divblock) {
    var daypart = Math.floor(new Date().getTime() / (12 * 3600 * 1000));
    var old = {};
    var today = {};
    var now = {};
    for(var k in divblock) {
	if (k > daypart - 14) {
	    divblock[k].forEach(function(hsh) {
		if (k == daypart) {
		    today[hsh] = true;
		} else {
		    old[hsh] = true;
		}
	    });
	} else {
	    delete divblock[k];
	}
    }
    return {
	check: function(key) {
	    var idx = hashCode(key) + '';
	    return (old[idx] || now[idx]);
	},
	add: function(key) {
	    var idx = hashCode(key) + '';
	    old[idx] = true;
	    today[idx] = true;
	    now[idx] = true;
	},
	commit: function() {
	    divblock[daypart] = Object.keys(today);
	    if (divblock[daypart].length > 500) {
		divblock[daypart] = [];
	    }
	    return divblock;
	}
    };
}

function score_track(track, divchecker) {
    var novel = divchecker.check(track.name) ? 0.0 : 1.0;
    var popularity = 0.0;
    if (track.popularity) { // spotify
	popularity = track.popularity / 100.0;
    } else if (track.playCount) { // rdio
	popularity = 1.0 - (100.0 / (track.playCount + 1));
	popularity = Math.min(1.0, Math.max(0.0, popularity)); // clamp to unit value
    }
    var score = novel + popularity / 2.0;
    return score
}

function formatDate(dt) {
    return dt.toISOString().substring(0, 19);
}

function rdio_get_access_token(oauth_token, oauth_secret, oauth_verifier) {
    var deferred = Q.defer();
    rdio.getAccessToken(
	oauth_token, oauth_secret, oauth_verifier,
	function(error, access_token, access_token_secret, results) {
	    if (error) {
		console.log('could not get access_token');
		deferred.reject(error);
	    } else {
		console.log('access_token ok', access_token, access_token_secret);
		deferred.resolve({'token': access_token, 'secret': access_token_secret});
	    }
	});
    return deferred.promise;
}

function make_rdio_api_fn(token, token_secret) {
    return function(args) {
	var deferred = Q.defer();
	rdio.api(token, token_secret, args, function(err, data, response) {
            if (err) {
		deferred.reject(err);
            } else {
		deferred.resolve(JSON.parse(data)['result']);
            }
	});
	return deferred.promise;
    };
}

function isRealVenue(venue) {
    if (venue.name.length < 12) return true;
    if (venue.name.match(/radio/i) || venue.name.length > 120) {
	return false;
    }
    return true;
}

function make_spotify_api_fn(access_token) {
    return {
	'getUsername': function() {
	    var url = 'https://api.spotify.com/v1/me';
	    return http({'method':'get', 'url':url, 'headers': {'Authorization': 'Bearer ' + access_token}, 'json':true}).
		then(function(r) { return r.id; });
	},
	'createPlaylist': function(username, name) {
	    var url = 'https://api.spotify.com/v1/users/' + username + '/playlists';
	    var data = {'name': name, 'public': false};
	    var headers = {
		'Authorization': 'Bearer ' + access_token,
		'Content-Type': 'application/json'
	    }
	    return http({'method':'post', 'url':url, 'body':data, json:true, headers: headers}).
		then(function(r) {return r.id;});
	},
	'addTracksToPlaylist': function(username, playlist, tracks) {
	    var url = 'https://api.spotify.com/v1/users/' + username +
		'/playlists/' + playlist +
		'/tracks';
	    var headers = {
		'Authorization': 'Bearer ' + access_token,
		'Content-Type': 'application/json'
            };
	    return http({method:'post', url:url, body:tracks, json:true, headers: headers}).
		then(function(r) {return r.id;});
	}
    };
}

function fetchEvents(opts, range) {
    var zipcode = opts.zipcode;
    var latlon = opts.latlon;
    var daysout = opts.daysout;
    var maxmiles = opts.maxmiles;
    var onlyavailable = opts.onlyavailable;
    range = (range > maxmiles) ? maxmiles : range;
    var dt = new Date();
    var startdt = formatDate(new Date(dt.getTime() - 2 * 3600 * 1000));
    var enddt = formatDate(new Date(dt.getTime() + ((daysout - 1) * 24 - 2) * 3600 * 1000));

    console.log('input', zipcode, opts.clientIp, latlon, startdt, enddt);
    var promise;

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
	if (onlyavailable) {
	    events = events.filter(function(e){e.ticket_status === 'available'});
	}
	events.forEach(function(event) {
	    var month = parseInt(event.datetime.substring(5, 7));
	    var day = parseInt(event.datetime.substring(8, 10));
	    event.datestring = month + '-' + day;
	    event.datetime_local = event.datetime;
	    event.performers = event.artists;
	    delete event.artists;
	});
	return events;
    });
    return promise.then(function(events) {
	var num_events = events.length;
	var target_count = Math.min(50, Math.max(4, Math.round(600 / range)));
	console.log('results at range ', range, ' : ', num_events, ' (target is:', target_count, ')');
	if (range >= maxmiles || num_events >= target_count) {
	    var performer_map = {};
	    events = events.slice(0, 40);
	    events.forEach(function(event) {
		if (isRealVenue(event.venue)) {
		    event.performers = event.performers.slice(0, 3);
		    event.performers.forEach(function(performer) {
			performer_map[performer.name]=event;
		    });
		}
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

function redirectOnCreate(res, links) {
    res.header('Location', '/#http=' + encodeURIComponent(links.http) +
	       '&app=' + encodeURIComponent(links.app));
    res.send(302);
}

function redirectToAuth(myKey, info, res, authStore) {
    var service = info.service;
    var trackKeys = info.track_keys;
    if (service === 'spotify') {
        var uri = 'https://accounts.spotify.com/authorize?client_id=' + config.SPOTIFY.client_id +
	    '&state=' + myKey +
            '&response_type=code' +
            '&scope=playlist-read-private%20playlist-modify%20playlist-modify-private' +
            '&redirect_uri=' + config.SPOTIFY.callback_url;
	return authStore.set(myKey, info).then(function(){
	    res.header('Location', uri);
	    res.send(302);
	}).done();
    } else if (service === 'rdio') {
        rdio.getRequestToken(function(error, oauth_token, oauth_token_secret, results){
            if (! error) {
                info['oauth_secret'] = oauth_token_secret;
                info['oauth_token'] = oauth_token;
		return authStore.set(myKey, info).then(function(){
		    var login = results['login_url'] + '?oauth_token=' + oauth_token + '&state='+myKey;
		    res.header('Location', login);
		    res.send(302);
		}).done();
            } else {
                console.log('error requesting login token from rdio: ', error);
                res.send(500);
            }
        });
    } else {
        res.send(400, 'Invalid service');
    }
}

function hashCode(string) {
    var hash = 0, i, chr, len;
    if (string.length == 0) return hash;
    for (i = 0, len = string.length; i < len; i++) {
	chr   = string.charCodeAt(i);
	hash  = ((hash << 5) - hash) + chr;
	hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

var NUM_TRACKS_CACHED = 7;

function spotifyArtist(performer) {
    var uri = config.SPOTIFY.artist_search_prefix + 'limit=5&q='+encodeURIComponent('"'+performer+'"');
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
	    uri = config.SPOTIFY.artist_prefix + artist.id + '/top-tracks?country=US';
	    return http({uri:uri, method:'get', json:true}).then(function(tracks_response) {
		var tracks = tracks_response.tracks;
		if (tracks.length === 0) {
		    console.log('no tracks for artist: '+performer);
		    return null;
		}
		function score_track(t) { return (t.popularity + 10.0) / (t.artists.length * t.artists.length); }
		tracks.sort(function(a,b) {return score_track(b) - score_track(a);});
		tracks = tracks.slice(0, NUM_TRACKS_CACHED);
		tracks = tracks.map(function(item) {
		    return {name: item.name, artist: performer, uri: item.uri, popularity: item.popularity, key: item.uri};
		});
		artist.tracks = tracks;
		return artist;
	    });
	}
    );
}

var rdio_cps = {'tm':0, 'ct':0};

function rdioArtist(performer) {
    var api = make_rdio_api_fn(undefined, undefined);
    function make_promise() {
	return api({'method': 'search','query':performer,'types':'artist','extras':'-*,key,name'}).then(function(artist_result) {
	    var hits = artist_result.results.filter(function(a){return a.name === performer;});
	    if (hits) {
		return hits[0];
	    } else {
		console.log('Artist not found on rdio ', performer, ' options ', artist_result.results);
		return null;
	    }
	}).then(function(artist) {
	    if (! artist) return null;
	    return api(
		{'method':'getTracksForArtist', 
		 'artist': artist.key, 
		 'count':NUM_TRACKS_CACHED, 
		 'extras':'-*,key,name,playCount'
		}
	    ).then(function(tracks) {
		if (!tracks) {
		    console.log('No tracks found on rdio for ', performer);
		    return null;
		}
		tracks = tracks.map(function(item) {
		    return {name: item.name, 
			    artist: performer,
			    key: item.key, 
			    playCount: item.playCount};
		});
		artist.tracks = tracks;
		return artist;
	    });
	});
    }
    var dt_to_second = new Date().toISOString().substring(0,19);
    if (rdio_cps.tm !== dt_to_second) {
	rdio_cps.tm = dt_to_second;
	rdio_cps.ct = 0;
	return make_promise();
    } else {
	rdio_cps.ct += 1;
	// aim for 5 per second(ish)
	var delay = ((rdio_cps.ct - 1) / 4) * 1000
	console.log('rdio throttle kick-in', delay);
	return Q.delay(delay).then(make_promise);
    }
}

function makePlaylist(service, authInfo, trackKeys) {
    console.log('making playlist ', authInfo, trackKeys);
    var access_token = authInfo.token;
    if (service == 'spotify') {
	var api = make_spotify_api_fn(access_token);
	return api.getUsername().then(function(username) {
	    if (username === undefined) throw new Error('access_token not working');
	    return api.createPlaylist(username, titlePlaylist()).then(function(playlist_id) {
		return api.addTracksToPlaylist(username, playlist_id, trackKeys).then(function() {
		    return {http: 'https://play.spotify.com/user/'+username+'/playlist/'+playlist_id,
			    app: 'spotify:user:'+username+':playlist:'+playlist_id};
		});
	    });
	});
    } else if (service == 'rdio') {
	var access_token_secret = authInfo.secret;
        var api = make_rdio_api_fn(access_token, access_token_secret);
	var payload = {'method': 'createPlaylist', 
		       'name': titlePlaylist(), 
		       'description': 'A playlist of local artists playing near you, now.',
		       'isPublished': 'false',
		       'tracks': trackKeys.join(',')};
	return api(payload).then(
	    function(result) {
		return {'http': 'http://www.rdio.com' + result.url};
	    }
	);
    } else {
	throw new Error('Invalid service');
    }
}


function getMusic(eventOptions, trackOptions, artistStore, divchecker) {
    var maxTracksPerArtist = trackOptions.maxTracksPerArtist;
    return fetchEvents(eventOptions, 2).then(function(performer_map) {
	var service = trackOptions.service;
	var playlistName = formatDate(new Date()).substring(0, 10) + '-music-tonight';
	var performers = Object.keys(performer_map);
	var tracksPerArtist = Math.round(22.0 / performers.length);
	var performerCacheKeys = performers.map(function(p){ return service+':'+p; });
	tracksPerArtist = Math.max(1, Math.min(maxTracksPerArtist, tracksPerArtist));
	return artistStore.mget(performerCacheKeys).then(function(cacheResults) {
	    var promises = performers.map(function(performer) {
		var artistCacheKey = service + ':' + performer;
		var cached = cacheResults[artistCacheKey];
		if (cached !== undefined) {
		    return Q.fcall(function(){return JSON.parse(cached);});
		} else {
                    var fetchfn = {'spotify': spotifyArtist, 'rdio': rdioArtist}[service];
                    return fetchfn(performer).then(function(result){
			artistStore.set(artistCacheKey, JSON.stringify(result)).done();
			return result;
		    });
		}
	    });
	    return Q.all(promises).then(function(artists) {
		var result_tracks = [];
		artists.forEach(function(artist) {
		    if (! artist) {return;}
		    var event = performer_map[artist.name];
		    var tracks = artist.tracks;
		    tracks.sort(function(a, b) { return score_track(b, divchecker) - score_track(a, divchecker); });
		    artist.tracks.slice(0, tracksPerArtist).forEach(function(track){
			track.event = event;
			divchecker.add(track.name);
			result_tracks.push(track);
		    });
		});
		return {name: playlistName, tracks:result_tracks};
	    });
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

function makeServer(artistStore, authStore) {
    
    var server = restify.createServer();
    
    server.on('uncaughtException', function(req, res, route, err) {
	console.log(err.stack);
	res.send(err);
    });
    
    server.use(restify.gzipResponse());
    server.use(cookieparser.parse);

    server.use( // CORS
	function crossOrigin(req,res,next){
	    res.header("Access-Control-Allow-Origin", "*");
	    res.header("Access-Control-Allow-Headers", "X-Requested-With");
	    return next();
	}
    );

    server.use(restify.bodyParser());
    server.use(restify.queryParser());

    server.get('/api/playlist', promised(function(req, res) {
	console.log('get playlist', req.params);

	var clientIp = req.headers['x-forwarded-for'] || 
	    req.connection.remoteAddress || 
	    req.socket.remoteAddress ||
	    req.connection.socket.remoteAddress;
	clientIp = clientIp.split(',')[0];

	var language = 'en-US';
	var acceptLanguages = req.headers['accept-language'];
	if (acceptLanguages) {
	    language = acceptLanguages.split(/[\,\;]/)[0];
	}

	var daysout = (req.params.daysout) ? parseInt(req.params.daysout) : 1;
	var maxmiles = (req.params.maxmiles) ? parseInt(req.params.maxmiles) : 125;
	var onlyavailable = (req.params.onlyavailable) ? (req.params.onlyavailable === 'true') : false;
	var eventOptions = {
	    zipcode: req.params.zip_code,
	    clientIp: clientIp,
	    latlon: req.params.latlon,
	    daysout: daysout,
	    maxmiles: maxmiles,
	    onlyavailable: onlyavailable
	};
	var trackOptions = {
	    service: (req.params.service) ? req.params.service : 'spotify',
	    maxTracksPerArtist: (req.params.maxartisttracks) ? parseInt(req.params.maxartisttracks) : 2
	};

        var myKey = clientCookie(req, res);
	return fetchUserInfo(authStore, myKey).then(function(info) {
	    var divchecker = getDiversityChecker(info.div);
	    
	    return getMusic(eventOptions, trackOptions, artistStore, divchecker).then(function(result) {
		result.language = language;
		info.div = divchecker.commit();
		console.log('new info', info);
		authStore.set(myKey, info).done();
		return result;
	    });
	});
    }));

    server.post('/api/music_svc_auth', function(req, res) {
        var service = req.params.service;
        var trackKeys = JSON.parse(req.params.track_keys);
        var myKey = clientCookie(req, res);
	authStore.get(myKey).then(function(authInfo) {
	    if (authInfo && authInfo.access) {
		authInfo.service = service;
		return makePlaylist(authInfo.service, authInfo.access, trackKeys).then(function(links) {
		    redirectOnCreate(res, links);
		}).then(function(){}, function() {
		    return redirectToAuth(myKey, authInfo, res, authStore);
		});
	    } else {
		var authInfo = {'track_keys': trackKeys, 'service': service};
		return redirectToAuth(myKey, authInfo, res, authStore);
	    }
	}).done();
    });

    server.get('/api/music_svc_callback', function(req, res) {
        var myKey = clientCookie(req, res);
	authStore.get(myKey).then(function(info) {
            var trackKeys = info.track_keys;
	    delete info.track_keys;
            var openlink = '';
	    
	    var promise;
            if (info.service === 'spotify') {
		var code = req.query.code || null;
		var state = req.query.state || null;
		if (state === null || state !== myKey) {
		    throw new Error('state mismatch: state:'+state+' vs cookie:'+myKey); 
		}
		var authOptions = {
		    url: 'https://accounts.spotify.com/api/token',
		    form: {
			code: code,
			redirect_uri: config.SPOTIFY.callback_url,
			grant_type: 'authorization_code'
		    },
		    headers: {
			'Authorization': 'Basic ' + (new Buffer(config.SPOTIFY.client_id + ':' + config.SPOTIFY.client_secret).toString('base64'))
		    },
		    method: 'post',
		    json: true
		};
		promise = http(authOptions).then(function(response) {
		    return {'token': response.access_token};
		});
		
		
            } else if (info.service === 'rdio') {
		promise = rdio_get_access_token(info.oauth_token, info.oauth_secret, req.params.oauth_verifier);
            } else {
		res.send(400, 'Invalid service');
		return;
	    }
	    promise = promise.then(function(accessdata) {
		info.access = accessdata;
		return makePlaylist(info.service, accessdata, trackKeys);
	    }).then(function(links) {
		redirectOnCreate(res, links);
	    });
	    return promise.then(
		function() {
		    return authStore.set(myKey, info);
		});
	}).done();
    });

    return server;
}

mysqlStore(pool, 'artists').then(function(artistStore) {
    return mysqlStore(pool, 'auth').then(function(authStore) {
	var server = makeServer(artistStore, authStore);
	server.listen(11810, function() {
	    console.log('%s listening at %s', server.name, server.url);
	});
    });
}).done();
