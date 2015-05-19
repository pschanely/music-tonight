var gulp = require('gulp');
var requireDir = require('require-dir');
var configFiles = requireDir('./config');
var frep = require('gulp-frep');
var imagemin = require('gulp-imagemin');
var mainBowerFiles = require('main-bower-files');
var print = require('gulp-print');
var inline = require('gulp-inline');
var uglify = require('gulp-uglify');
var minifyCss = require('gulp-minify-css');
var inlinesource = require('gulp-inline-source');
var inlineimg = require('gulp-inline-image-html');
 
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

function buildto(dir, isweb) {
    var html;
    if (isweb) {
	html = gulp.src('./src/*.html');
        html = html.pipe(inlinesource({compress:true}));
    } else {
	html = gulp.src(['./src/*.html', './src/*.css']);
    }
    html.pipe(frep(config_patterns))
	.pipe(gulp.dest(dir));

    gulp.src(mainBowerFiles({paths:'./src', debugging:false}), { base:'./src/bower_components'})
	.pipe(gulp.dest(dir + '/bower_components'));

    gulp.src('./src/img/*')
        .pipe(gulp.dest(dir + '/img'));

}

gulp.task('default', function() {
    buildto('./dist', true);
});

gulp.task('app', function() {
    buildto('../mobile/www', false);
});

gulp.task('watch', function() {
    gulp.watch('./src/*.css', ['default','app']);
    gulp.watch('./src/*.html', ['default','app']);
    gulp.watch('./src/img/*', ['default','app']);
});
