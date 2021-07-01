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
            build : 'build',
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
                '<%= paths.build %>/js/*',
                '<%= paths.docs %>/build/js/*'
            ],
            styles : [
                '<%= paths.build %>/less/*',
                '<%= paths.build %>/css/*',
                '<%= paths.docs %>/build/less/*',
                '<%= paths.docs %>/build/css/*'
            ],
            images : [
                '<%= paths.build %>/img/*',
                '<%= paths.docs %>/build/img/*'
            ],
            fonts : [
                '<%= paths.build %>/fonts/*',
                '<%= paths.docs %>/build/fonts/*'
            ],
            stuff : [
                '<%= paths.docs %>/build/content/*',
                '<%= paths.docs %>/build/stuff/*'
            ],
            libs : [
                '<%= paths.build %>/libs/*',
                '<%= paths.docs %>/build/libs/*'
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
                    '<%= paths.src %>/common/js/config.js',
                    '<%= paths.src %>/common/js/polyfill.js',
                    '<%= paths.src %>/common/js/common.js',
                    '<%= paths.src %>/common/js/modules.js',
                    '<%= paths.src %>/common/js/parts.js',
                    '<%= paths.src %>/common/js/**/*.js',
                    '<%= paths.src %>/abstracts/Controller/**/*.js',
                    '<%= paths.src %>/abstracts/Container/**/*.js',
                    '<%= paths.src %>/abstracts/**/*.js',
                    '<%= paths.src %>/components/**/*.js',
                    '<%= paths.src %>/fields/**/*.js',
                    '!<%= paths.src %>/**/langs/*.js',
                    '!<%= paths.src %>/common/js/init.js',
                    '<%= paths.src %>/common/js/init.js'
                ],
                dest: '<%= paths.build %>/js/<%= pkg.name %>.js'
            },
            scripts_langs: {
                files : [{
                    src : '<%= paths.src %>/**/langs/ru.js',
                    dest : '<%= paths.build %>/js/<%= pkg.name %>.ru.<%= pkg.version %>.js'
                },{
                    src : '<%= paths.src %>/**/langs/en.js',
                    dest : '<%= paths.build %>/js/<%= pkg.name %>.en.<%= pkg.version %>.js'
                }]
            },
            scripts_docs : {
                src : [
                    '<%= paths.build %>/js/<%= pkg.name %>.js',
                    '<%= paths.docs %>/build/js/<%= pkg.name %>.variables.js',
                    '<%= paths.docs %>/src/js/common.js',
                    '<%= paths.docs %>/src/js/components/**/*.js',
                    '<%= paths.docs %>/src/js/components.js'
                ],
                dest : '<%= paths.docs %>/build/js/<%= pkg.name %>.js'
            },
            styles: {
                options: {
                    banner: '<%= banner %>'
                },
                src: [
                    '<%= components.animatecss.styles %>',
                    '<%= components.codemirror.styles %>',
                    '<%= paths.src %>/common/less/variables/**/.less',
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
                    '<%= paths.src %>/components/**/*.less',
                    '<%= paths.src %>/fields/**/*.less'
                ],
                dest: '<%= paths.build %>/less/<%= pkg.name %>.less'
            },
            styles_docs : {
                src : [
                    '<%= paths.build %>/less/<%= pkg.name %>.less',
                    '<%= paths.docs %>/src/less/variables/*.less',
                    '<%= paths.docs %>/src/less/common.less'
                ],
                dest : '<%= paths.docs %>/build/less/<%= pkg.name %>.less'
            },
            variables: {
                src: [
                    '<%= paths.src %>/**/variables/*.less',
                    '<%= paths.src %>/**/variables.less'
                ],
                dest: '<%= paths.build %>/less/<%= pkg.name %>.variables.less'
            },
            variables_docs : {
                src : [
                    '<%= paths.build %>/less/<%= pkg.name %>.variables.less',
                    '<%= paths.docs %>/src/less/variables/*.less'
                ],
                dest : '<%= paths.docs %>/build/less/<%= pkg.name %>.variables.less'
            },
            codemirror : {
                src : [
                    '<%= components.codemirror.scripts %>'
                ],
                dest : '<%= paths.build %>/libs/codemirror_comp/codemirror.js'
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

        lessvars: {
            options: {
                units : true,
                format : function(vars){
                    return 'window.LESS = ' + JSON.stringify(vars) + ';';
                }
            },
            build : {
                src : ['<%= paths.build %>/less/<%= pkg.name %>.variables.less'],
                dest : '<%= paths.build %>/js/<%= pkg.name %>.variables.js'
            },
            docs : {
                src : ['<%= paths.docs %>/build/less/<%= pkg.name %>.variables.less'],
                dest : '<%= paths.docs %>/build/js/<%= pkg.name %>.variables.js'
            }
        },

        less: {
            options: {
                strictMath: false,
                strictUnits: false
            },
            build: {
                src: ['<%= paths.build %>/less/<%= pkg.name %>.less'],
                dest: '<%= paths.build %>/css/<%= pkg.name %>.css'
            },
            docs: {
                src: ['<%= paths.docs %>/build/less/<%= pkg.name %>.less'],
                dest: '<%= paths.docs %>/build/css/<%= pkg.name %>.css'
            }
        },

        replace: {
            options: {
                variables: {
                    'VERSION' : '<%= pkg.version %>'
                }
            },
            scripts: {
                src: ['<%= paths.build %>/js/<%= pkg.name %>.js'],
                dest: '<%= paths.build %>/js/<%= pkg.name %>.js'
            },
            scripts_docs: {
                src: ['<%= paths.docs %>/build/js/<%= pkg.name %>.js'],
                dest: '<%= paths.docs %>/build/js/<%= pkg.name %>.js'
            },
            styles: {
                src: ['<%= paths.build %>/less/<%= pkg.name %>.less'],
                dest: '<%= paths.build %>/less/<%= pkg.name %>.less'
            },
            styles_docs: {
                src: ['<%= paths.docs %>/build/less/<%= pkg.name %>.less'],
                dest: '<%= paths.docs %>/build/less/<%= pkg.name %>.less'
            },
            variables: {
                src: ['<%= paths.build %>/less/<%= pkg.name %>.variables.less'],
                dest: '<%= paths.build %>/less/<%= pkg.name %>.variables.less'
            },
            variables_docs: {
                src: ['<%= paths.docs %>/build/less/<%= pkg.name %>.variables.less'],
                dest: '<%= paths.docs %>/build/less/<%= pkg.name %>.variables.less'
            }
        },

        uglify : {
            build : {
                files: [{
                    src: ['<%= paths.build %>/js/<%= pkg.name %>.js'],
                    dest: '<%= paths.build %>/js/<%= pkg.name %>.min.js'
                },{
                    src : '<%= paths.build %>/js/<%= pkg.name %>.ru.js',
                    dest : '<%= paths.build %>/js/<%= pkg.name %>.ru.min.js'
                },{
                    src : '<%= paths.build %>/js/<%= pkg.name %>.en.js',
                    dest : '<%= paths.build %>/js/<%= pkg.name %>.en.min.js'
                }]
            },
            codemirror : {
                src : ['<%= paths.build %>/libs/codemirror_comp/codemirror.js'],
                dest : '<%= paths.build %>/libs/codemirror_comp/codemirror.min.js'
            }
        },

        cssmin : {
            build : {
                src : ['<%= paths.build %>/css/<%= pkg.name %>.css'],
                dest : '<%= paths.build %>/css/<%= pkg.name %>.min.css'
            }
        },

        imagemin : {
            build : {
                options: {
                    optimizationLevel: 3
                },
                files : [{
                    expand : true,
                    cwd : '<%= paths.build %>/img/',
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
                    cwd: '<%= paths.build %>/img/',
                    src: [
                        '**/*.{png,jpg}',
                        '!animated/**/*.*'
                    ],
                    dest: '<%= paths.build %>/img/',
                    ext: '.webp'
                }]
            }
        },

        copy : {
            images : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.src %>/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.build %>/img/'
                }]
            },
            images_docs : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.build %>/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/build/img/<%= pkg.name %>/'
                }]
            },
            images_docs_self : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.docs %>/src/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/build/img/'
                }]
            },
            images_optimize : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.temp %>/img/',
                    src : ['**/*.*'],
                    dest : '<%= paths.build %>/img/'
                }]
            },
            fonts : {
                files: [{
                    expand : true,
                    cwd : '<%= paths.src %>/fonts/',
                    src : ['**/*.*', '!**/*.json'],
                    dest : '<%= paths.build %>/fonts/'
                }]
            },
            fonts_docs : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.build %>/fonts/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/build/fonts/<%= pkg.name %>/'
                }]
            },
            fonts_docs_self : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.docs %>/src/fonts/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/build/fonts/'
                }]
            },
            libs : {
                files : [{
                    expand : true,
                    cwd : '<%= components.less.dist %>',
                    src : ['**/*.*'],
                    dest : '<%= paths.build %>/libs/less/'
                },{
                    expand : true,
                    cwd : '<%= components.codemirror.dist %>',
                    src : ['**/*.*'],
                    dest : '<%= paths.build %>/libs/codemirror/'
                }]
            },
            libs_docs : {
                files : [{
                    expand : true,
                    cwd : '<%= paths.build %>/libs/',
                    src : ['**/*.*'],
                    dest : '<%= paths.docs %>/build/libs/'
                }]
            },
            stuff_docs : {
                files : [{
                    expand: true,
                    cwd: '<%= paths.docs %>/src/',
                    src: ['*.*'],
                    dest: '<%= paths.docs %>/build/'
                },{
                    expand: true,
                    cwd: '<%= paths.docs %>/src/content/',
                    src: ['**/*.*'],
                    dest: '<%= paths.docs %>/build/content/'
                },{
                    expand: true,
                    cwd: '<%= paths.docs %>/src/stuff/',
                    src: ['**/*.*'],
                    dest: '<%= paths.docs %>/build/stuff/'
                }]
            }
        },

        watch : {
            scripts : {
                files : [
                    '<%= paths.src %>/js/**/*.js',
                    '<%= paths.docs %>/src/js/**/*.js'
                ],
                tasks : ['scripts']
            },
            styles : {
                files : [
                    '<%= paths.src %>/less/**/*.less',
                    '<%= paths.docs %>/src/less/**/*.less'
                ],
                tasks : ['styles']
            },
            images : {
                files : [
                    '<%= paths.src %>/img/**/*.*',
                    '<%= paths.docs %>/src/img/**/*.*'
                ],
                tasks : ['images']
            },
            fonts : {
                files : [
                    '<%= paths.src %>/fonts/**/*.*',
                    '!<%= paths.src %>/fonts/**/*.json',
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

    grunt.registerTask('scripts', ['concat:scripts', 'replace:scripts', 'concat:scripts_docs']);
    grunt.registerTask('images', ['svgcss:build', 'copy:images', 'copy:images_docs', 'copy:images_docs_self']);
    grunt.registerTask('styles', ['variables', 'concat:styles', 'replace:styles', 'concat:styles_docs', 'less:build', 'less:docs']);
    grunt.registerTask('fonts', ['copy:fonts', 'copy:fonts_docs', 'copy:fonts_docs_self']);
    grunt.registerTask('stuff', ['copy:stuff_docs']);
    grunt.registerTask('libs', ['concat:codemirror', 'uglify:codemirror', 'copy:libs', 'copy:libs_docs']);
    grunt.registerTask('variables', ['concat:variables', 'replace:variables', 'concat:variables_docs', 'lessvars']);
    grunt.registerTask('pre', ['svgcss:build', 'variables']);
};
