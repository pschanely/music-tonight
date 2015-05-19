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
var soundclouder = require("soundclouder");

var os = require('os');

function linear_scorer(graph) {
    return function(value) {
	if (value < graph[0][0]) { return graph[0][1]; }
	for(var idx=1; idx < graph.length; idx++) {
	    var next_x = graph[idx][0];
	    var prev_x = graph[idx - 1][0];
	    if (prev_x <= value && value < next_x) {
		var prev_y = graph[idx - 1][1];
		var next_y = graph[idx][1];
		var progress = (value - prev_x) / (next_x - prev_x);
		return progress * next_y + (1.0 - progress) * prev_y;
	    }
	}
	return graph[graph.length - 1][1];
    };
}

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

var callback_url = config.HOST_PREFIX + '/api/music_svc_callback';

config.RDIO.callback_url = callback_url;
config.SPOTIFY.callback_url = callback_url;

var rdio = rdiolib(config.RDIO);
soundclouder.init(config.SOUNDCLOUD.client_id, config.SOUNDCLOUD.client_secret, callback_url);

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
		    openRequests[key] = pool.boundQuery('SELECT k,v FROM ' + table + ' WHERE k=? COLLATE utf8_unicode_ci', key).then(function(rows) {
			if (rows.length == 0) return undefined;
			var ret = JSON.parse(rows[0].v);
                        return ret;
		    }).fin(function() {
			delete openRequests[key];
		    });
		}
		return openRequests[key];
	    },
	    'all': function() {
		return pool.boundQuery('SELECT k,v FROM ' + table).then(function(rows) {
                    var result = {};
                    rows.forEach(function(row){result[row.k] = JSON.parse(row.v);});
                    return result;
                });
	    },
	    'mget': function(keys) {
		if (keys.length === 0) return Q.fcall(function(){return {};});
		var clauses = keys.map(function(k){return 'k=?';}).join(' OR ');
		return pool.boundQuery('SELECT k,v FROM ' + table + ' WHERE '+clauses+' COLLATE utf8_unicode_ci', keys).then(function(rows) {
		    var result = {};
		    rows.forEach(function(row){result[row.k] = JSON.parse(row.v);});
		    return result;
		});
	    },
	    'set': function(key, val) {
		var sql = 'INSERT INTO ' + table + ' (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)';
		return pool.boundQuery(sql, [key, JSON.stringify(val)]);
	    },
	    'mset': function(bindings) {
		var sql = '';
		var params = [];
		for(var key in bindings) {
		    if (sql) { sql +=';'; }
		    sql += 'INSERT INTO ' + table + ' (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)';
		    params.push(key);
		    params.push(JSON.stringify(bindings[key]));
		}
		return pool.boundQuery(sql, params);
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
    if (! myKey) {
        myKey = uuid.v4();
        res.setCookie('svc_auth_key', myKey);
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

function score_result(track) {
    var dtstring = track.event.datetime_local;
    var year = dtstring.substring(0, 4);
    var month = dtstring.substring(5, 7);
    var day = dtstring.substring(8, 10);
    var dtscore = parseInt(year + month + day);
    return dtscore * 10 + Math.random();
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

function soundcloud_get_access_token(code) {
    var deferred = Q.defer();
    soundclouder.auth(code, function(error, access_token) {
	if (error) {
	    console.log('could not get access_token');
            deferred.reject(error);
        } else {
	    console.log('access_token ok', access_token);
            deferred.resolve({'token': access_token});
	}
    });
    return deferred.promise;
}

function make_rdio_api_fn(token, token_secret) {
    return function(args) {
	function make_promise() {
	    var deferred = Q.defer();
	    rdio.api(token, token_secret, args, function(err, data, response) {
		if (err) {
		    deferred.reject(err);
		} else {
		    deferred.resolve(JSON.parse(data)['result']);
		}
	    });
	    return deferred.promise;
	}
	return backoff(make_promise, 'Developer Over Qps');
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

function allPages(reqGenerator, resultProcessor, pageSize) {
    function onePage(pageNum) {
	return http(reqGenerator(pageSize, pageNum)).then(function(response) {
	    var results = resultProcessor(response);
	    console.log('page '+pageNum+' had '+results.length+' results');
	    if (results.length < pageSize || pageNum == 1) {
		return results;
	    } else {
		return onePage(pageNum + 1).then(function(subresults) {
		    results.forEach(function(r){subresults.push(r);});
		    return subresults;
		});
	    }
	});
    }
    return onePage(1);
}

function fetchEvents(opts) {
    var zipcode = opts.zipcode;
    var latlon = opts.latlon;
    var daysout = opts.daysout;
    var maxmiles = opts.maxmiles;
    var onlyavailable = opts.onlyavailable;
    var dt = new Date();
    var startdt = formatDate(new Date(dt.getTime() - 2 * 3600 * 1000));
    var enddt = formatDate(new Date(dt.getTime() + ((daysout - 1) * 24 - 2) * 3600 * 1000));

    console.log('fetchEvents input:', zipcode, opts.clientIp, latlon, startdt, enddt);

    var uri = 'http://api.bandsintown.com/events/search?app_id=musictonight.millstonecw.com&format=json';
    if (latlon) {
	uri += '&location=' + latlon;
    } else {
	if (opts.clientIp !== '127.0.0.1') {
	    uri += '&location=' + opts.clientIp;
	} else {
	    uri += '&location=40.7436300,-73.9906270';
	}
    }
    uri += '&radius=' + maxmiles;
    uri += '&date=' + startdt.substring(0, 10) + ',' + enddt.substring(0, 10);

    function reqGenerator(pageSize, pageNum) {
	var cur = uri + '&per_page=' + pageSize + '&page=' + pageNum;
	console.log(cur);
	return {method:'get', json:true, uri:cur};
    }
    function resultProcessor(response) {
	if (response.errors) {
	    var errors = response.errors;
	    if (errors[0] === 'Unknown Location') {
		throw new Error('client error: cannot_geo_ip');
	    } else {
		throw new Error(errors);
	    }
	} else {
	    return response;
	}
    }
    var promise = allPages(reqGenerator, resultProcessor, 100).then(function(events) {
	if (onlyavailable) {
	    events = events.filter(function(e){return e.ticket_status === 'available'});
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
	var performer_map = {};
	events.forEach(function(event) {
	    if (isRealVenue(event.venue)) {
		event.performers = event.performers.slice(0, 3);
		event.performers.forEach(function(performer) {
		    performer_map[performer.name]=event;
		});
	    }
	});
	return performer_map;
    });
}

function redirectOnCreate(res, links) {
    console.log('sending playlist redirect', new Date().getTime());
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
	    console.log('spotify auth redirect', new Date().getTime());
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
		    console.log('rdio auth redirect', new Date().getTime());
		    res.header('Location', login);
		    res.send(302);
		}).done();
            } else {
                console.log('error requesting login token from rdio: ', error);
                res.send(500);
            }
        });
    } else if (service === 'soundcloud') {
	var uri = 'https://soundcloud.com/connect?client_id=' + config.SOUNDCLOUD.client_id +
            '&state=' + myKey + '&response_type=code&redirect_uri=' + encodeURIComponent(callback_url);
	return authStore.set(myKey, info).then(function(){
	    res.header('Location', uri);
	    res.send(302);
	}).done();
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
    var uri = config.SPOTIFY.artist_search_prefix + 'limit=' + NUM_TRACKS_CACHED + '&q='+encodeURIComponent('"'+performer+'"');
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

function backoff(fn, errstr) {
    return fn()['catch'](function(err) {
	if (JSON.stringify(err).indexOf(errstr) === -1) {
	    console.log('err without backoff', err);
	    return Q.reject(err);
	} else {
	    console.log('backoff err', err);
	    return Q.delay(Math.round(1000 * Math.random())).then(function(){
		return backoff(fn, errstr);
	    });
	}
    });
}

function rdioArtists(performers) {
    var api = make_rdio_api_fn(undefined, undefined);
    var SLEEP = 120;
    var cur_delay = -SLEEP;
    return Q.all(performers.map(function(performer) {
	cur_delay += SLEEP;
	return Q.delay(cur_delay).then(function() {
	    return api({'method':'search','query':performer,'types':'artist','extras':'-*,key,name,trackKeys'}).then(
		function(artist_result) {
		    var hits = artist_result.results.filter(function(a){return a.name === performer;});
		    if (hits) {
			return hits[0];
		    } else {
			console.log('Artist not found on rdio ', performer, ' options ', artist_result.results);
			return null;
		    }
		}
	    );
	});
    })).then(function(artists) {
	var track_key_to_artist = {};
	var name_to_artist = {};
	artists.forEach(function(artist) {
	    if (artist) {
		name_to_artist[artist.name] = artist;
		artist.tracks = [];
		artist.trackKeys.slice(0, NUM_TRACKS_CACHED).forEach(function(track_key) {
		    track_key_to_artist[track_key] = artist;
		});
	    }
	});
	return api(
	    {'method': 'get',
	     'keys': Object.keys(track_key_to_artist).join(','),
	     'extras':'-*,key,name,playCount'
	    }
	).then(function(resp) {
	    for(var track_key in resp) {
		var track = resp[track_key];
		var artist = track_key_to_artist[track.key];
		artist.tracks.push({
		    name: track.name, 
		    artist: artist.name,
		    key: track.key, 
		    playCount: track.playCount});
	    }
	    return name_to_artist;
	});
    });
}

function soundcloudArtist(performer) {
    var base = 'http://api.soundcloud.com';
    var uri = base + '/users?limit=1&q='+encodeURIComponent(performer) + '&client_id=' + config.SOUNDCLOUD.client_id;
    return http({uri: uri, method: 'get', json: true}).then(function(response) {
	if (!(response.length > 0)) return null;
	var artistid = response[0].id;
	var uri = base + '/users/' + artistid + '/tracks?limit=50&client_id=' + config.SOUNDCLOUD.client_id;
	return http({uri: uri, method: 'get', json: true}).then(function(trackResponse) {
            var tracks = trackResponse.map(function(item) {
		return {
		    name: item.title,
                    artist: performer,
                    key: item.id,
                    playCount: 1.0 - (1/(1+item.favoritings_count)) * (1/(1+item.playback_count))
		};
            });
	    tracks.sort(function(a, b) {return b.playCount - a.playCount});
	    tracks = tracks.slice(0, NUM_TRACKS_CACHED);
	    return {
		'name': performer,
		'tracks': tracks
	    };
	});
    });
}

function makePlaylist(service, authInfo, trackKeys) {
    var access_token = authInfo.token;
    if (service == 'spotify') {
	var api = make_spotify_api_fn(access_token);
	return api.getUsername().then(function(username) {
	    if (username === undefined) throw new Error('access_token not working');
	    return api.createPlaylist(username, titlePlaylist()).then(function(playlist_id) {
		function sendBucket() {
		    var page = trackKeys.splice(0, 99);
		    return api.addTracksToPlaylist(username, playlist_id, page).then(function() {
			if (trackKeys.length > 0) return sendBucket();
		    });
		}
		return sendBucket().then(function() {
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
		       'isPublished': 'true',
		       'tracks': trackKeys.join(',')};
	return api(payload).then(
	    function(result) {
		return {http: 'http://www.rdio.com' + result.url,
			app: 'rdio://www.rdio.com' + result.url};
	    }
	);
    } else if (service === 'soundcloud') {
	var title = titlePlaylist();
	var authbody = ('oauth_token=' + encodeURIComponent(access_token) +
			'&client_id=' + encodeURIComponent(config.SOUNDCLOUD.client_id))
	var formbody = (authbody + 
			'&playlist[sharing]=public' +
			'&playlist[title]=' +  encodeURIComponent(title));
	var req = {
	    method: 'POST',
	    url: 'http://api.soundcloud.com/playlists',
	    json: true,
	    form: formbody
	};
	console.log('url', req);
	return http(req).then(function(response) {
	    if (! response.permalink_url) {
		throw new Error('Unable to create playlist:' + JSON.stringify(response.errors));
	    }
	    function sendBucket() {
		var page = trackKeys.splice(0, 9999);
		var body = authbody + page.map(function(k){ return '&playlist[tracks][][id]=' + encodeURIComponent(k); }).join('');
		var url = 'http://api.soundcloud.com/playlists/' + response.id;
		return http({method:'PUT', json:true, url: url, form: body}).then(function(resp) {
		    if (trackKeys.length > 0) return sendBucket();
		});
	    }
	    return sendBucket().then(function() {
		return {
		    http: response.permalink_url,
		    app: 'soundcloud:playlists:' + response.id
		};
	    });
	})
    } else {
	throw new Error('Invalid service');
    }
}

function mapq(fn) {
    return function(items) {
	var map = {};
	var delay = 0;
	return Q.all(items.map(function(item){
	    delay += 100;
	    return Q.delay(delay).then(function(){return fn(item);}).then(function(val) {
		map[item] = val;
	    });
	})).then( function() { 
	    return map; 
	});
    };
}
	

function getMusic(eventOptions, trackOptions, artistStore, divchecker) {
    var maxTracksPerArtist = trackOptions.maxTracksPerArtist;
    return fetchEvents(eventOptions).then(function(performer_map) {
	var service = trackOptions.service;
	var playlistName = formatDate(new Date()).substring(0, 10) + '-music-tonight';
	var performers = Object.keys(performer_map);
	var tracksPerArtist = Math.round(22.0 / performers.length);
	var performerCacheKeys = performers.map(function(p){ return service+':'+p; });
	tracksPerArtist = Math.max(1, Math.min(maxTracksPerArtist, tracksPerArtist));
	return artistStore.mget(performerCacheKeys).then(function(cacheResults) {
	    var cached = [];
	    var uncached = [];
	    performers.forEach(function(performer) {
		var artistCacheKey = service + ':' + performer;
		if (cacheResults[artistCacheKey] !== undefined) {
		    cached.push(cacheResults[artistCacheKey]);
		} else {
		    uncached.push(performer);
		}
	    });
	    console.log(cached.length + ' cached, ' + uncached.length + ' to be fetched.');
	    var promise;
	    if (uncached.length === 0) {
		promise = Q.fcall(function(){ return cached; });
	    } else {
		var fetchfn = {'spotify': mapq(spotifyArtist), 'rdio': rdioArtists, 'soundcloud':mapq(soundcloudArtist)}[service];
		promise = fetchfn(uncached).then(function(results) {
		    var result_list = [];
		    var cacheUpdate = {};
		    uncached.forEach(function(key) {
			var result = results[key];
			result_list.push(result);
			cacheUpdate[service + ':' + key] = result;
		    });
		    artistStore.mset(cacheUpdate).done();
		    return cached.concat(result_list);
		});
	    }
	    return promise.then(function(artists) {
		var all_tracks = [];
		artists.forEach(function(artist) {
		    if (! artist) {return;}
		    var event = performer_map[artist.name];
		    var tracks = artist.tracks;
		    tracks.sort(function(a, b) { return score_track(b, divchecker) - score_track(a, divchecker); });
		    artist.tracks.slice(0, tracksPerArtist).forEach(function(track){
			track.event = event;
			divchecker.add(track.name);
			all_tracks.push(track);
		    });
		});
		var result_tracks = all_tracks.sort(function(a, b) { return score_result(a) - score_result(b); });

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
	console.log('/api/playlist', req.params, new Date().getTime());

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
		authStore.set(myKey, info).done();
		return result;
	    });
	});
    }));

    server.get('/api/music_svc_auth', function(req, res) {
	console.log('/api/music_svc_auth', req.params, new Date().getTime());
        var service = req.params.service;
        var trackKeys = JSON.parse(req.params.track_keys);
        var myKey = clientCookie(req, res);
	authStore.get(myKey).then(function(info) {
	    if (info && info.auth && info.auth[service] && info.auth[service].token) {
		var auth = info.auth[service];
		info.service = service;
		info.track_keys = trackKeys;
		return makePlaylist(info.service, auth, trackKeys).then(function(links) {
		    redirectOnCreate(res, links);
		}).then(function(){}, function(err) {
		    console.log('Could not use saved access info (', auth, '):', err);
		    return redirectToAuth(myKey, info, res, authStore);
		});
	    } else {
		var info = {'track_keys': trackKeys, 'service': service};
		return redirectToAuth(myKey, info, res, authStore);
	    }
	}).done();
    });

    server.get('/api/music_svc_callback', function(req, res) {
	console.log('/api/music_svc_callback', req.params, new Date().getTime());
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
	    } else if (info.service === 'soundcloud') {
		promise = soundcloud_get_access_token(req.params.code);
            } else {
		res.send(400, 'Invalid service');
		return;
	    }
	    promise = promise.then(function(accessdata) {
		if (!info.auth) {
		    info.auth = {};
		}
		info.auth[info.service] = accessdata;
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

function upgrade1(authStore) {
    return authStore.all().then(function(map) {
	console.log(map);
	var promises = [];
	for(var key in map) {
	    console.log('key', key);
	    var info = map[key];
	    if (info.access && info.access.token) {
		var token = info.access.token;
		var service = '';
		if (token.toLowerCase() === token) { // rdio tokens are lowercase
		    service = 'rdio';
		} else {
		    service = 'spotify';
		}
		if (! info.auth) {
		    info.auth = {};
		    info.auth[service] = info.access;
		}
		console.log(key);
		console.log(info);
		promises.push(authStore.set(key, info));
	    }
	}
	return Q.all(promises).then(function() { console.log('upgrade complete'); }).done();
    });
}

var lastarg = process.argv[process.argv.length - 1];
mysqlStore(pool, 'artists2').then(function(artistStore) {
    return mysqlStore(pool, 'auth').then(function(authStore) {
	if (lastarg == 'upgrade') {
	    return upgrade1(authStore);
	} else {
	    var server = makeServer(artistStore, authStore);
	    server.listen(11810, function() {
		console.log('%s listening at %s', server.name, server.url);
	    });
	}
    });
}).done();
