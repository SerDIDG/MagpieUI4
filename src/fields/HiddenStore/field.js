cm.define('Com.HiddenStoreField', {
    extend: 'Com.AbstractInputContainer',
    params: {
        constructor: 'Com.AbstractInput',
        storeRaw: false,
        triggerName: null,
    },
},
function() {
    Com.AbstractInputContainer.apply(this, arguments);
});

cm.getConstructor('Com.HiddenStoreField', function(classConstructor, className, classProto, classInherit) {
    classProto.onConstructStart = function() {
        const that = this;
        // Binds
        that.processDataHandler = that.processData.bind(that);
    };

    classProto.onRenderController = function() {
        const that = this;
        // Get trigger field
        const field = that.components.form.getField(that.params.triggerName);
        if (field) {
            that.components.trigger = field.controller;
            that.components.trigger.addEvent('onSelect', that.processDataHandler);
            that.components.trigger.addEvent('onReset', that.resetHandler);
            that.processData();
        }
    };

    classProto.processData = function() {
        const that = this;
        const data = that.params.storeRaw ? that.components.trigger.getRaw() : that.components.trigger.get();
        that.set(data);
    };
});

/****** FORM FIELD COMPONENT *******/

Com.FormFields.add('hidden-store', {
    node: cm.node('input', {'type': 'hidden'}),
    visible: false,
    fieldConstructor: 'Com.AbstractFormField',
    constructor: 'Com.HiddenStoreField',
});
