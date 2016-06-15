cm.define('Com.AbstractFileManager', {
    'extend' : 'Com.AbstractController',
    'events' : [
        'onSelect',
        'onComplete',
        'onGet',
        'onRenderHolderStart',
        'onRenderHolderProcess',
        'onRenderHolderEnd',
        'onRenderContentStart',
        'onRenderContentProcess',
        'onRenderContentEnd'
    ],
    'params' : {
        'embedStructure' : 'replace',
        'showStats' : true,
        'max' : 0,                                                        // 0 - infinity
        'Com.FileStats' : {
            'embedStructure' : 'append'
        }
    }
},
function(params){
    var that = this;
    that.nodes = {};
    that.components = {};
    that.items = [];
    that.isMultiple = false;
    // Call parent class construct
    Com.AbstractController.apply(that, arguments);
});

cm.getConstructor('Com.AbstractFileManager', function(classConstructor, className, classProto){
    var _inherit = classProto._inherit;

    classProto.construct = function(){
        var that = this;
        // Bind context to methods
        that.completeHandler = that.complete.bind(that);
        // Add events
        // Call parent method
        _inherit.prototype.construct.apply(that, arguments);
        return that;
    };

    classProto.validateParams = function(){
        var that = this;
        that.isMultiple = !that.params['max'] || that.params['max'] > 1;
        return that;
    };

    classProto.get = function(){
        var that = this;
        that.triggerEvent('onGet', that.items);
        return that;
    };

    classProto.complete = function(){
        var that = this;
        that.triggerEvent('onComplete', that.items);
        return that
    };

    classProto.renderView = function(){
        var that = this;
        that.triggerEvent('onRenderViewStart');
        // Structure
        that.nodes['container'] = cm.node('div', {'class' : 'com__file-manager'},
            that.nodes['inner'] = cm.node('div', {'class' : 'inner'},
                that.renderHolder(),
                that.renderContent()
            )
        );
        // Events
        that.triggerEvent('onRenderViewProcess');
        that.triggerEvent('onRenderViewEnd');
        return that;
    };

    classProto.renderHolder = function(){
        var that = this,
            nodes = {};
        that.triggerEvent('onRenderHolderStart');
        // Structure
        nodes['container'] = cm.node('div', {'class' : 'com__file-manager__holder is-hidden'},
            nodes['inner'] = cm.node('div', {'class' : 'inner'})
        );
        // Events
        that.triggerEvent('onRenderHolderProcess');
        that.nodes['holder'] = nodes;
        that.triggerEvent('onRenderHolderEnd');
        return nodes['container'];
    };

    classProto.renderContent = function(){
        var that = this,
            nodes = {};
        that.triggerEvent('onRenderContentStart');
        // Structure
        nodes['container'] = cm.node('div', {'class' : 'com__file-manager__content is-hidden'});
        // Events
        that.triggerEvent('onRenderContentProcess');
        that.nodes['content'] = nodes;
        that.triggerEvent('onRenderContentEnd');
        return nodes['container'];
    };

    classProto.renderViewModel = function(){
        var that = this;
        if(that.params['showStats']){
            cm.getConstructor('Com.FileStats', function(classObject, className){
                cm.removeClass(that.nodes['content']['container'], 'is-hidden');
                that.components['stats'] = new classObject(
                    cm.merge(that.params[className], {
                        'container' : that.nodes['content']['container']
                    })
                );
            });
        }
        return that;
    };

    /* *** PROCESS FILES *** */

    classProto.processFiles = function(data){
        var that = this,
            files = [],
            max;
        if(cm.isArray(data)){
            files = data.map(function(file){
                return that.convertFile(file);
            });
        }else if(cm.isObject(data)){
            files.push(that.convertFile(data));
        }
        if(!that.params['max']){
            that.items = files;
        }else if(files.length){
            max = Math.min(0, that.params['max'], files.length);
            that.items = files.slice(0, max);
        }else{
            that.items = [];
        }
        that.triggerEvent('onSelect', that.items);
        return that;
    };

    classProto.convertFile = function(data){
        return data;
    };
});