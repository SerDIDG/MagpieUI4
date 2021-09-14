cm.define('Com.GridlistFilter', {
    'extend' : 'Com.AbstractController',
    'events' : [
        'onRenderContentStart',
        'onRenderContent',
        'onRenderContentProcess',
        'onRenderContentEnd'
    ],
    'params' : {
        'controllerEvents' : true,
        'renderStructure' : true,
        'renderStructureContent' : true,
        'embedStructureOnRender' : true,
        'embedStructure' : 'append',
        'controller' : null,
        'minLength' : 0,
        'delay' : 'cm._config.requestDelay',
        'action' : {}                             // Params object. Variables: %query%
    }
},
function(params){
    var that = this;
    // Call parent class construct
    Com.AbstractController.apply(that, arguments);
});

cm.getConstructor('Com.GridlistFilter', function(classConstructor, className, classProto, classInherit){
    classProto.construct = function(){
        var that = this;
        // Variables
        that.query = '';
        that.requestDelay = null;
        // Binds
        that.focusHandler = that.focus.bind(that);
        that.blurHandler = that.blur.bind(that);
        that.inputEventHandler = that.inputEvent.bind(that);
        that.iconEventHanlder = that.iconEvent.bind(that);
        // Call parent method
        classInherit.prototype.construct.apply(that, arguments);
    };

    /******* VIEW MODEL *******/

    classProto.renderView = function(){
        var that = this;
        that.triggerEvent('onRenderViewStart');
        that.nodes.container = cm.node('div', {'class' : 'com__gridlist__filter'});
        // Component content
        cm.appendChild(that.nodes.contentContainer, that.nodes.container);
        if(that.params.renderStructureContent){
            that.nodes.contentContainer = that.renderContent();
            cm.appendChild(that.nodes.contentContainer, that.nodes.container);
        }
        that.triggerEvent('onRenderViewProcess');
        that.triggerEvent('onRenderViewEnd');
        return that;
    };

    classProto.renderViewModel = function(){
        var that = this;
        // Call parent method
        classInherit.prototype.renderViewModel.apply(that, arguments);
        // Find Gridlist
        if(that.params.controller){
            that.components.controller = that.params.controller;
        }
        return that;
    };

    /******* FILTER *******/

    classProto.renderContent = function(){
        var that = this,
            nodes = {};
        that.nodes.content = nodes;
        // Structure
        that.triggerEvent('onRenderContentStart');
        nodes.container = cm.node('div', {'class' : 'pt__input'},
            nodes.input = cm.node('input', {'type' : 'search', 'class' : 'input', 'autocomplete' : 'off', 'placeholder' : that.message('placeholder')}),
            nodes.icon = cm.node('div', {'class' : 'icon linked icon svg__search', 'title' : that.message('search')})
        );
        that.triggerEvent('onRenderContent');
        that.triggerEvent('onRenderContentProcess');
        cm.addEvent(nodes.input, 'input', that.inputEventHandler);
        cm.addEvent(nodes.icon, 'click', that.iconEventHanlder);
        that.triggerEvent('onRenderContentEnd');
        // Export
        return nodes.container;
    };

    classProto.inputEvent = function(){
        var that = this;
        that.query = that.nodes.content.input.value;
        // Clear previous request
        that.requestDelay && clearTimeout(that.requestDelay);
        that.components.controller && that.components.controller.abort();
        // Change icon status
        if(that.query.length > 0){
            that.nodes.content.icon.title = that.message('clear');
            cm.replaceClass(that.nodes.content.icon, 'svg__search', 'svg__close-danger');
        }else{
            that.nodes.content.icon.title = that.message('search');
            cm.replaceClass(that.nodes.content.icon, 'svg__close-danger', 'svg__search');
        }
        // Request
        if(that.query.length >= that.params.minLength){
            that.requestDelay = setTimeout(function(){
                that.callbacks.request(that, {
                    'config' : cm.clone(that.params.action),
                    'query' : that.query
                });
            }, that.params.delay);
        }
    };

    classProto.iconEvent = function(){
        var that = this;
        if(that.query.length > 0){
            that.reset();
        }else{
            that.focus();
        }
    };

    /******* CALLBACKS *******/

    classProto.callbacks.prepare = function(that, params){
        params.config = that.callbacks.beforePrepare(that, params);
        params.config = cm.objectReplace(params.config, {
            '%query%' : params.query
        });
        params.config = that.callbacks.afterPrepare(that, params);
        return params.config;
    };

    classProto.callbacks.beforePrepare = function(that, params){
        return params.config;
    };

    classProto.callbacks.afterPrepare = function(that, params){
        return params.config;
    };

    classProto.callbacks.request = function(that, params){
        params = cm.merge({
            'response' : null,
            'data' : null,
            'config' : null,
            'query' : ''
        }, params);
        // Validate config
        params.config = that.callbacks.prepare(that, params);
        // Set new action to Gridlist
        that.components.controller && that.components.controller.setAction({
            'params' : params.config
        });
    };

    /******* PUBLIC *******/

    classProto.get = function(){
        var that = this;
        return that.query;
    };

    classProto.focus = function(){
        var that = this;
        that.nodes.content.input.focus();
        return that;
    };

    classProto.blur = function(){
        var that = this;
        that.nodes.content.input.blur();
        return that;
    };

    classProto.reset = function(){
        var that = this;
        that.nodes.content.input.value = '';
        that.inputEvent();
        return that;
    };
});
