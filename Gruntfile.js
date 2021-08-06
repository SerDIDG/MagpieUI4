'use strict';

module.exports = function(grunt) {
    const fs = require('fs');
    const webp = require("imagemin-webp");
    // Load all grunt tasks
    require('load-grunt-tasks')(grunt);
    // Display how match time it took to build each task
    require('@lodder/time-grunt')(grunt);
    // Project configuration.
    grunt.initConfig({
        pkg: grunt.file.readJSON('package.json'),
        banner: '/*! ************ <%= pkg.name %> v<%= pkg.version %> ************ */\n',
        timestamp: '<%= Date.now() %>',

        paths : {
            modules : 'node_modules',
            src : 'src',
            dist : 'dist',
            docs : 'docs',
            temp : 'temp'
        },

        components : {
            less : {
                path : '<%= paths.modules %>/less',
                dist : '<%= components.less.path %>/dist',
                scripts : [
                    '<%= components.less.dist %>/less.js'
                ]
            },
            animatecss : {
                path : '<%= paths.modules %>/animate.css',
                styles : [
                    '<%= components.animatecss.path %>/animate.css'
                ]
            },
            codemirror : {
                path : '<%= paths.modules %>/codemirror',
                dist : '<%= components.codemirror.path %>',
                scripts : [
                    '<%= components.codemirror.dist %>/lib/codemirror.js',
                    '<%= components.codemirror.dist %>/mode/javascript/javascript.js',
                    '<%= components.codemirror.dist %>/mode/css/css.js',
                    '<%= components.codemirror.dist %>/mode/xml/xml.js',
                    '<%= components.codemirror.dist %>/mode/htmlmixed/htmlmixed.js'
                ],
                styles : [
                    '<%= components.codemirror.dist %>/lib/codemirror.css'
                ]
            },
            tinycolor : {
                path : '<%= paths.modules %>/tinycolor2',
                scripts : [
                    '<%= components.tinycolor.path %>/tinycolor.js'
                ]
            }
        },

        clean : {
            options: {
                force: true
            },
            scripts : [
                '<%= paths.dist %>/js/*',
                '<%= paths.docs %>/dist/js/*'
            ],
            styles : [
                '<%= paths.dist %>/less/*',
                '<%= paths.dist %>/css/*',
                '<%= paths.docs %>/dist/less/*',
                '<%= paths.docs %>/dist/css/*'
            ],
            images : [
                '<%= paths.dist %>/img/*',
                '<%= paths.docs %>/dist/img/*'
            ],
            fonts : [
                '<%= paths.dist %>/fonts/*',
                '<%= paths.docs %>/dist/fonts/*'
            ],
            stuff : [
                '<%= paths.docs %>/dist/content/*',
                '<%= paths.docs %>/dist/stuff/*'
            ],
            libs : [
                '<%= paths.dist %>/libs/*',
                '<%= paths.docs %>/dist/libs/*'
            ],
            temp : [
                '<%= paths.temp %>/less',
                '<%= paths.temp %>/js',
                '<%= paths.temp %>/img'
            ]
        },

        concat: {
            scripts: {
                options: {
                    banner: '<%= banner %>'
                },
                src: [
                    '<%= components.tinycolor.scripts %>',
                    '<%= paths.src %>/common/js/polyfill.js',
                    '<%= paths.src %>/common/js/config.js',
                    '<%= paths.src %>/common/js/common.js',
                    '<%= paths.src %>/common/js/define.js',
                    '<%= paths.src %>/common/js/modules.js',
                    '<%= paths.src %>/common/js/parts.js',
                    '<%= paths.src %>/common/js/**/*.js',
                    '<%= paths.src %>/abstracts/Controller/**/*.js',
                    '<%= paths.src %>/abstracts/Container/**/*.js',
                    '<%= paths.src %>/abstracts/**/*.js',
                    '<%= paths.src %>/components/Tooltip/**/*.js',
                    '<%= paths.src %>/components/ScrollPagination/**/*.js',
                    '<%= paths.src %>/components/Pagination/**/*.js',
                    '<%= paths.src %>/components/**/*.js',
                    '<%= paths.src %>/fields/MultipleInput/**/*.js',
                    '<%= paths.src %>/fields/**/*.js',
                    '!<%= paths.src %>/**/strings/*.js',
                    '!<%= paths.src %>/common/js/init.js',
                    '<%= paths.src %>/common/js/init.js'
                ],
                dest: '<%= paths.dist %>/js/<%= pkg.name %>.js'
            },
            scripts_strings: {
                files : [{
                    src: [
                        '<%= paths.src %>/common/**/strings/ru.js',
                        '<%= paths.src %>/**/strings/ru.js'
                    ],
                    dest : '<%= paths.dist %>/js/<%= pkg.name %>.ru.js'
                },{
                    src: [
                        '<%= paths.src %>/common/**/strings/en.js',
                        '<%= paths.src %>/**/strings/en.js'
                    ],
                    dest : '<%= paths.dist %>/js/<%= pkg.name %>.en.js'
                }]
            },
            scripts_docs : {
                src : [
                    '<%= paths.dist %>/js/<%= pkg.name %>.js',
                    '<%= paths.dist %>/js/<%= pkg.name %>.en.js',
                    '<%= paths.docs %>/dist/js/<%= pkg.name %>.variables.js',
                    '<%= paths.docs %>/src/js/common.js',
                    '<%= paths.docs %>/src/js/components/**/*.js',
                    '<%= paths.docs %>/src/js/components.js'
                ],
                dest : '<%= paths.docs %>/dist/js/<%= pkg.name %>.js'
            },
            styles: {
                options: {
                    banner: '<%= banner %>'
                },
                src: [
                    '<%= components.animatecss.styles %>',
                    '<%= components.codemirror.styles %>',
                    '<%= paths.src %>/common/less/variables/**/*.less',
                    '<%= paths.src %>/common/less/svg.less',
                    '<%= paths.src %>/common/less/mixins.less',
                    '<%= paths.src %>/common/less/common.less',
                    '<%= paths.src %>/common/less/*.less',
                    '<%= paths.src %>/common/less/common/Font.less',
                    '<%= paths.src %>/common/less/common/Size.less',
                    '<%= paths.src %>/common/less/common/Indent.less',
                    '<%= paths.src %>/common/less/common/Colors.less',
                    '<%= paths.src %>/common/less/common/Aspect.less',
                    '<%= paths.src %>/common/less/common/Icons.less',
                    '<%= paths.src %>/common/less/common/Tags.less',
                    '<%= paths.src %>/common/less/common/Inputs.less',
                    '<%= paths.src %>/common/less/common/Buttons.less',
                    '<%= paths.src %>/common/less/common/List.less',
                    '<%= paths.src %>/common/less/common/**/*.less',
                    '<%= paths.src %>/common/less/parts/**/*.less',
                    '<%= paths.src %>/common/less/layouts/**/*.less',
                    '<%= paths.src %>/abstracts/**/*.less',
                    '<%= paths.src %>/components/Tooltip/**/*.less',
                    '<%= paths.src %>/components/**/*.less',
                    '<%= paths.src %>/fields/**/*.less'
                ],
                dest: '<%= paths.dist %>/less/<%= pkg.name %>.less'
            },
            styles_docs : {
                src : [
                    '<%= paths.dist %>/less/<%= pkg.name %>.less',
                    '<%= paths.docs %>/src/less/variables/*.less',
                    '<%= paths.docs %>/src/less/common.less'
                ],
                dest : '<%= paths.docs %>/dist/less/<%= pkg.name %>.less'
            },
            codemirror : {
                src : [
                    '<%= components.codemirror.scripts %>'
                ],
                dest : '<%= paths.dist %>/libs/codemirror_comp/codemirror.js'
            }
        },

        svgcss : {
            options : {
                previewhtml : null
            },
            svg : {
                options : {
                    cssprefix : 'svg__',
                    csstemplate : '<%= paths.src %>/common/hbs/svg.hbs'
                },
                files: [{
                    src: ['<%= paths.src %>/common/img/svg/*.svg'],
                    dest : '<%= paths.src %>/common/less/svg.less'
                }]
            }
        },

        less: {
            options: {
                strictMath: false,
                strictUnits: false
            },
            build: {
                src: ['<%= paths.dist %>/less/<%= pkg.name %>.less'],
                dest: '<%= paths.dist %>/css/<%= pkg.name %>.css'
            },
            docs: {
                src: ['<%= paths.docs %>/dist/less/<%= pkg.name %>.less'],
                dest: '<%= paths.docs %>/dist/css/<%= pkg.name %>.css'
            }
        },

        replace: {
            options: {
                variables: {
                    'VERSION' : '<%= pkg.version %>'
                }
            },
            scripts: {
                src: ['<%= paths.dist %>/js/<%= pkg.name %>.js'],
                dest: '<%= paths.dist %>/js/<%= pkg.name %>.js'
            },
            scripts_docs: {
                src: ['<%= paths.docs %>/dist/js/<%= pkg.name %>.js'],
                dest: '<%= paths.docs %>/dist/js/<%= pkg.name %>.js'
            },
            styles: {
                src: ['<%= paths.dist %>/less/<%= pkg.name %>.less'],
                dest: '<%= paths.dist %>/less/<%= pkg.name %>.less'
            },
            styles_docs: {
                src: ['<%= paths.docs %>/dist/less/<%= pkg.name %>.less'],
                dest: '<%= paths.docs %>/dist/less/<%= pkg.name %>.less'
            }
        },

        uglify : {
            build : {
                files: [{
                    src: ['<%= paths.dist %>/js/<%= pkg.name %>.js'],
                    dest: '<%= paths.dist %>/js/<%= pkg.name %>.min.js'
                },{
                    src : '<%= paths.dist %>/js/<%= pkg.name %>.ru.js',
                    dest : '<%= paths.dist %>/js/<%= pkg.name %>.ru.min.js'
                },{
                    src : '<%= paths.dist %>/js/<%= pkg.name %>.en.js',
                    dest : '<%= paths.dist %>/js/<%= pkg.name %>.en.min.js'
                }]
            },
            codemirror : {
                src : ['<%= paths.dist %>/libs/codemirror_comp/codemirror.js'],
                dest : '<%= paths.dist %>/libs/codemirror_comp/codemirror.min.js'
            }
        },

        cssmin : {
            build : {
                src : ['<%= paths.dist %>/css/<%= pkg.name %>.css'],
                dest : '<%= paths.dist %>/css/<%= pkg.name %>.min.css'
            }
        },

        imagemin : {
            build : {
                options: {
                    optimizationLevel: 3
                },
                files : [{
                    expand : true,
                    cwd : '<%= paths.dist %>/img/',
                    src : [
                        '**/*.*',
                        '!animated/**/*.*'
                    ],
                    dest : '<%= paths.temp %>/img/'
                }]
            },
            webp: {
                options: {
                    use: [webp({
                        quality: 85
                    })]
                },
                files: [{
                    expand: true,
                    cwd: '<%= paths.dist %>/img/',
                    src: [
                        '**/*.{png,jpg}',
                        '!animated/**/*.*'
                    ],
                    dest: '<%= paths.dist %>/img/',
                    ext: '.webp'
                }]
            }
        },

        copy : {
            images: {
                files: [{
                    expand: true,
                    cwd: '<%= paths.src %>/',
                    src: ['**/img/**/*.*'],
                    dest : '<%= paths.dist %>/img/',
                    rename: function(dest, src){
                        return dest + src.replace('/img/', '/');
                    }
                }]
            },
            images_docs : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.dist %>/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/dist/img/<%= pkg.name %>/'
                }]
            },
            images_docs_self : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.docs %>/src/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/dist/img/'
                }]
            },
            images_optimize : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.temp %>/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.dist %>/img/'
                }]
            },
            fonts : {
                files: [{
                    expand : true,
                    cwd : '<%= paths.src %>/common/fonts/',
                    src : ['**/*.*', '!**/*.json'],
                    dest : '<%= paths.dist %>/fonts/'
                }]
            },
            fonts_docs : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.dist %>/fonts/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/dist/fonts/<%= pkg.name %>/'
                }]
            },
            fonts_docs_self : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.docs %>/src/fonts/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/dist/fonts/'
                }]
            },
            libs : {
                files : [{
                    expand : true,
                    cwd : '<%= components.less.dist %>',
                    src : ['**/*.*'],
                    dest : '<%= paths.dist %>/libs/less/'
                },{
                    expand : true,
                    cwd : '<%= components.codemirror.dist %>',
                    src : ['**/*.*'],
                    dest : '<%= paths.dist %>/libs/codemirror/'
                }]
            },
            libs_docs : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.dist %>/libs/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/dist/libs/'
                }]
            },
            stuff_docs : {
                files : [{
                    expand: true,
                    cwd: '<%= paths.docs %>/src/',
                    src: ['*.*'],
                    dest: '<%= paths.docs %>/dist/'
                },{
                    expand: true,
                    cwd: '<%= paths.docs %>/src/content/',
                    src: ['**/*.*'],
                    dest: '<%= paths.docs %>/dist/content/'
                },{
                    expand: true,
                    cwd: '<%= paths.docs %>/src/stuff/',
                    src: ['**/*.*'],
                    dest: '<%= paths.docs %>/dist/stuff/'
                }]
            }
        },

        watch : {
            scripts : {
                files : [
                    '<%= paths.src %>/**/*.js',
                    '<%= paths.docs %>/src/**/*.js'
                ],
                tasks : ['scripts']
            },
            styles : {
                files : [
                    '<%= paths.src %>/**/*.less',
                    '<%= paths.docs %>/src/**/*.less'
                ],
                tasks : ['styles']
            },
            images : {
                files : [
                    '<%= paths.src %>/../img/**/*.*',
                    '<%= paths.docs %>/src/../img/**/*.*'
                ],
                tasks : ['images']
            },
            fonts : {
                files : [
                    '<%= paths.src %>/common/fonts/**/*.*',
                    '!<%= paths.src %>/common/fonts/**/*.json',
                    '<%= paths.docs %>/src/fonts/**/*.*',
                    '!<%= paths.docs %>/src/fonts/**/*.json'
                ],
                tasks : ['fonts']
            },
            stuff : {
                files : [
                    '<%= paths.docs %>/src/*.*',
                    '<%= paths.docs %>/src/content/**/*.*',
                    '<%= paths.docs %>/src/stuff/**/*.*'
                ],
                tasks : ['stuff']
            }
        }
    });

    // Custom Tasks
    grunt.registerTask('default', ['clean', 'pre', 'scripts', 'images', 'styles', 'fonts', 'libs', 'stuff']);
    grunt.registerTask('optimize', ['clean:temp', 'default', 'uglify:build', 'cssmin', 'imagemin', 'copy:images_optimize', 'clean:temp']);
    grunt.registerTask('watcher', ['watch']);

    grunt.registerTask('scripts', ['concat:scripts', 'concat:scripts_strings', 'replace:scripts', 'concat:scripts_docs']);
    grunt.registerTask('images', ['clean:images', 'svgcss', 'copy:images', 'copy:images_docs', 'copy:images_docs_self']);
    grunt.registerTask('styles', ['concat:styles', 'replace:styles', 'concat:styles_docs', 'less:build', 'less:docs']);
    grunt.registerTask('fonts', ['copy:fonts', 'copy:fonts_docs', 'copy:fonts_docs_self']);
    grunt.registerTask('stuff', ['copy:stuff_docs']);
    grunt.registerTask('libs', ['concat:codemirror', 'uglify:codemirror', 'copy:libs', 'copy:libs_docs']);
    grunt.registerTask('pre', ['svgcss']);
};
