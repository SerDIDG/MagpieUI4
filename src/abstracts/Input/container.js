cm.define('Com.AbstractInputContainer', {
    extend: 'Com.AbstractController',
    events: [
        'onRenderControllerStart',
        'onRenderControllerProcess',
        'onRenderController',
        'onRenderControllerEnd',
        'onSelect',
        'onChange',
        'onReset',
    ],
    params: {
        renderStructure: false,
        embedStructureOnRender: false,
        controllerEvents: true,
        constructor: 'Com.AbstractInput',
        params: {},
    },
},
function() {
    Com.AbstractController.apply(this, arguments);
});

cm.getConstructor('Com.AbstractInputContainer', function(classConstructor, className, classProto, classInherit) {
    classProto.construct = function() {
        const that = this;
        // Binds
        that.resetHandler = that.reset.bind(that);
        that.enableHandler = that.enable.bind(that);
        that.disableHandler = that.disable.bind(that);
        // Call parent method
        classInherit.prototype.construct.apply(that, arguments);
    };

    classProto.onValidateParams = function() {
        const that = this;
        that.components.formField = that.params.formField;
        that.components.form = that.params.form;
    };

    classProto.renderViewModel = function() {
        const that = this;
        that.renderController();
    };

    classProto.renderController = function() {
        const that = this;
        cm.getConstructor(that.params.constructor, (ClassConstructor) => {
            that.triggerEvent('onRenderControllerStart');
            let params = that.validateControllerParams();
            that.components.controller = new ClassConstructor(params);
            that.triggerEvent('onRenderControllerProcess', that.components.controller);
            that.renderControllerEvents();
            that.triggerEvent('onRenderController', that.components.controller);
            that.triggerEvent('onRenderControllerEnd', that.components.controller);
        });
    };

    classProto.validateControllerParams = function() {
        const that = this;
        return cm.merge(that.params.constructorParams, {
            node: that.params.node,
            value: that.params.value,
            defaultValue: that.params.defaultValue,
        });
    };

    classProto.renderControllerEvents = function() {
        var that = this;
        that.components.controller.addEvent('onSelect', (Controller, data) => {
            that.triggerEvent('onSelect', data);
        });
        that.components.controller.addEvent('onChange', (Controller, data) => {
            that.triggerEvent('onChange', data);
        });
        that.components.controller.addEvent('onReset', (Controller, data) => {
            that.triggerEvent('onReset', data);
        });
    };

    /******* PUBLIC *******/

    classProto.set = function(value) {
        var that = this;
        cm.isFunction(that.components.controller?.set) && that.components.controller.set(value);
        return that;
    };

    classProto.get = function() {
        var that = this;
        return cm.isFunction(that.components.controller?.get) && that.components.controller.get();
    };

    classProto.getRaw = function() {
        var that = this;
        return cm.isFunction(that.components.controller?.getRaw) && that.components.controller.getRaw() || that.get();
    };

    classProto.reset = function() {
        var that = this;
        return cm.isFunction(that.components.controller?.reset) && that.components.controller.reset();
    };

    classProto.enable = function() {
        var that = this;
        cm.isFunction(that.components.controller?.enable) && that.components.controller.enable();
        return that;
    };

    classProto.disable = function() {
        var that = this;
        cm.isFunction(that.components.controller?.disable) && that.components.controller.disable();
        return that;
    };

    classProto.blur = function() {
        var that = this;
        cm.isFunction(that.components.controller?.enable) && that.components.controller.enable();
        return that;
    };

    classProto.focus = function() {
        var that = this;
        cm.isFunction(that.components.controller?.enable) && that.components.controller.enable();
        return that;
    };

    classProto.toggleError = function(value) {
        var that = this;
        cm.isFunction(that.components.controller?.toggleError) && that.components.controller.toggleError(value);
        return that;
    };
});
