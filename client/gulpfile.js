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
    { pattern: /APP_SERVER_URL/g, replacement: config.APP_SERVER_URL },
    { pattern: /SPOTIFY_CLIENT_ID/g, replacement: config.SPOTIFY_CLIENT_ID },
    { pattern: /GOOGLE_API_KEY/g, replacement: config.GOOGLE_API_KEY }
];

gulp.task('default', function() {

    gulp.src('./src/*.html')
	.pipe(frep(config_patterns))
	.pipe(gulp.dest('./dist'));

    gulp.src(mainBowerFiles({paths:'./src', debugging:true}), { base:'./src/bower_components'})
	.pipe(gulp.dest('./dist/bower_components'));

    gulp.src('./src/img/*')
        .pipe(imagemin())
        .pipe(gulp.dest('./dist/img'));

});

gulp.task('watch', function() {
    gulp.watch('./src/*.html', ['default']);
    gulp.watch('./src/img/*', ['default']);
});
