var gulp = require('gulp');
var requireDir = require('require-dir');
var configFiles = requireDir('./config');
var frep = require('gulp-frep');

var config = {}
for(var fileName in configFiles) {
    var configObj = configFiles[fileName];
    for (var attrname in configObj) { config[attrname] = configObj[attrname]; }
}

var config_patterns = [
    { pattern: /GOOGLE_ANALYTICS_ID/g, replacement: config.GOOGLE_ANALYTICS_ID },
    { pattern: /MUSIC_TONIGHT_SERVER/g, replacement: config.MUSIC_TONIGHT_SERVER },
    { pattern: /SPOTIFY_CLIENT_ID/g, replacement: config.SPOTIFY_CLIENT_ID }
];

gulp.task('default', function() {
    gulp.src('./src/index.html')
	.pipe(frep(config_patterns))
	.pipe(gulp.dest('./'))    
});
