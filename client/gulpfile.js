var gulp = require('gulp');
var requireDir = require('require-dir');
var configFiles = requireDir('./config');
var frep = require('gulp-frep');
var imagemin = require('gulp-imagemin');
var mainBowerFiles = require('main-bower-files');
var print = require('gulp-print');

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
	.pipe(gulp.dest('./dist'));

    gulp.src(mainBowerFiles({paths:'./src', debugging:true}), { base:'./src/bower_components'})
	.pipe(print())
	.pipe(gulp.dest('./dist/bower_components'));

    gulp.src('./src/img/*')
        .pipe(imagemin())
        .pipe(gulp.dest('./dist/img'));

});
