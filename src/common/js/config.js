window.cm = {
    '_version': '@@VERSION',
    '_lang': 'en',
    '_locale' : 'en-IN',
    '_loadTime': Date.now(),
    '_isDocumentReady': false,
    '_isDocumentLoad': false,
    '_debug': true,
    '_debugAlert': false,
    '_deviceType': 'desktop',
    '_deviceOrientation': 'landscape',
    '_adaptive': false,
    '_baseUrl': [window.location.protocol, window.location.hostname].join('//'),
    '_pathUrl': '',
    '_assetsUrl': [window.location.protocol, window.location.hostname].join('//'),
    '_scrollSize': 0,
    '_pageSize': {},
    '_clientPosition': {'left': 0, 'top': 0},
    '_config': {
        'redrawOnLoad': true,
        'motionAsymmetric': 'cubic-bezier(.5,0,.15,1)',
        'motionSmooth': 'ease-in-out',
        'animDuration': 250,
        'animDurationShort': 150,
        'animDurationLong': 500,
        'loadDelay': 500,
        'lazyDelay': 1000,
        'hideDelay': 250,
        'hideDelayShort': 150,
        'hideDelayLong': 500,
        'autoHideDelay': 2000,
        'requestDelay': 300,
        'adaptiveFrom': 768,
        'screenTablet': 1024,
        'screenTabletPortrait': 768,
        'screenMobile': 640,
        'screenMobilePortrait': 480,
        'dateFormat': '%Y-%m-%d',
        'dateTimeFormat': '%Y-%m-%d %H:%i:%s',
        'dateFormatCase': 'nominative',
        'timeFormat': '%H:%i:%s',
        'displayDateFormat': '%F %j, %Y',
        'displayDateTimeFormat': '%F %j, %Y, %H:%i',
        'displayDateFormatCase': 'nominative',
        'tooltipIndent': 4,
        'tooltipTop': 'targetHeight + 4',
        'tooltipDown': 'targetHeight + 4',
        'tooltipUp': '- (selfHeight + 4)',
    },
    '_variables': {
        '%baseUrl%': 'cm._baseUrl',
        '%assetsUrl%': 'cm._assetsUrl',
        '%pathUrl%': 'cm._pathUrl',
        '%version%': 'cm._version',
    },
};

window.Mod = {};
window.Part = {};
window.Com = {};
