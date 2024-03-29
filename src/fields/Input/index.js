cm.define('Com.Input', {
    'extend' : 'Com.AbstractInput',
    'events' : [
        'onEnterPress',
        'onFocus',
        'onBlur'
    ],
    'params' : {
        'controllerEvents' : true,
        'type' : 'text',
        'lazy' : false,
        'delay' : 'cm._config.requestDelay',
        'icon' : null
    }
},
function(params){
    var that = this;
    // Call parent class construct
    Com.AbstractInput.apply(that, arguments);
});

cm.getConstructor('Com.Input', function(classConstructor, className, classProto, classInherit){
    classProto.construct = function(){
        var that = this;
        // Variables
        that.selectionStartInitial = null;
        that.selectionEndInitial = null;
        that.isFocus = false;
        that.lazyDelay = null;
        that.constraints = {};
        // Bind context to methods
        that.focusHandler = that.focus.bind(that);
        that.blurHandler = that.blur.bind(that);
        that.inputEventHandler = that.inputEvent.bind(that);
        that.focusEventHandler = that.focusEvent.bind(that);
        that.blurEventHandler = that.blurEvent.bind(that);
        that.setValueHandler = that.setValue.bind(that);
        that.selectValueHandler = that.selectValue.bind(that);
        that.lazyValueHandler = that.lazyValue.bind(that);
        that.inputKeyDownHanlder = that.inputKeyDown.bind(that);
        that.inputKeyPressHanlder = that.inputKeyPress.bind(that);
        that.iconEventHanlder = that.iconEvent.bind(that);
        // Call parent method
        classInherit.prototype.construct.apply(that, arguments);
    };

    classProto.onEnable = function(){
        var that = this;
        that.nodes['content']['input'].disabled = false;
    };

    classProto.onDisable = function(){
        var that = this;
        that.nodes['content']['input'].disabled = true;
    };

    /*** VIEW MODEL ***/

    classProto.renderContent = function(){
        var that = this;
        that.triggerEvent('onRenderContentStart');
        // Structure
        that.nodes['content'] = that.renderContentView();
        // Attributes
        that.renderContentAttributes();
        // Events
        that.triggerEvent('onRenderContentProcess');
        that.renderContentEvents();
        that.triggerEvent('onRenderContentEnd');
        // Push
        return that.nodes['content']['container'];
    };

    classProto.renderContentView = function(){
        var that = this,
            nodes = {};
        if(that.params['type'] === 'textarea'){
            nodes['container'] = nodes['input'] = cm.node('textarea', {'class' : 'input textarea'});
        }else{
            nodes['container'] = cm.node('div', {'class' : 'pt__input'},
                nodes['inner'] = cm.node('div', {'class' : 'inner'},
                    nodes['input'] = cm.node('input', {'type' : that.params['type'], 'class' : 'input'})
                )
            );
            // Icon
            if(that.params['icon']){
                nodes['icon'] = cm.node('div', {'class' : that.params['icon']});
                cm.appendChild(nodes['icon'], nodes['inner']);
            }
        }
        return nodes;
    };

    classProto.renderContentAttributes = function(){
        var that = this;
        that.nodes['content']['input'].required = that.params['required'];
        // Min / Max length
        cm.setInputMinLength(that.nodes['content']['input'], that.params['minLength'], that.params['min']);
        cm.setInputMaxLength(that.nodes['content']['input'], that.params['maxLength'], that.params['max']);
        // Placeholder / Title
        if(!cm.isEmpty(that.params['id'])){
            that.nodes['content']['input'].setAttribute('id', that.params['id']);
        }
        if(!cm.isEmpty(that.params['placeholder'])){
            that.nodes['content']['input'].placeholder = that.params['placeholder'];
            if(that.nodes['content']['icon']){
                that.nodes['content']['icon'].title = that.params['placeholder'];
            }
        }
        if(!cm.isEmpty(that.params['autocomplete'])){
            that.nodes['content']['input'].setAttribute('autocomplete', that.params['autocomplete']);
        }
        if(!cm.isEmpty(that.params['title'])){
            that.nodes['content']['input'].title = that.params['title'];
            if(that.nodes['content']['icon']){
                that.nodes['content']['icon'].title = that.params['title'];
            }
        }
        if(!cm.isEmpty(that.params['ariaLabel'])){
            that.nodes['content']['input'].setAttribute('aria-label', that.params['ariaLabel']);
        }
        if(that.params['renderName']){
            that.nodes['content']['input'].name = that.params['visibleName'] || that.params['name'];
        }
    };

    classProto.renderContentEvents = function(){
        var that = this;
        cm.addEvent(that.nodes['content']['input'], 'input', that.inputEventHandler);
        cm.addEvent(that.nodes['content']['input'], 'focus', that.focusEventHandler);
        cm.addEvent(that.nodes['content']['input'], 'blur', that.blurEventHandler);
        cm.addEvent(that.nodes['content']['input'], 'change', that.setValueHandler);
        cm.addEvent(that.nodes['content']['input'], 'keydown', that.inputKeyDownHanlder);
        cm.addEvent(that.nodes['content']['input'], 'keypress', that.inputKeyPressHanlder);
        cm.addEvent(that.nodes['content']['icon'], 'click', that.iconEventHanlder);
    };

    /*** EVENTS ***/

    classProto.inputKeyDown = function(e){
        var that = this;
        that.selectionStartInitial = that.nodes['content']['input'].selectionStart;
        that.selectionEndInitial = that.nodes['content']['input'].selectionStart;
    };

    classProto.inputKeyPress = function(e){
        var that = this;
        if(that.params['type'] !== 'textarea' && cm.isKeyCode(e.keyCode, 'enter')){
            cm.preventDefault(e);
            that.setValue();
            that.nodes['content']['input'].blur();
            that.triggerEvent('onEnterPress', that.value);
        }
    };

    classProto.inputEvent = function(){
        var that = this;
        that.execConstraint('onInput', false);
        that.selectValue(true);
        if(that.params['lazy']){
            that.lazyValue(true);
        }
    };

    classProto.focusEvent = function(){
        var that = this;
        that.isFocus = true;
        that.execConstraint('onFocus', false);
        that.triggerEvent('onFocus', that.value);
    };

    classProto.blurEvent = function(){
        var that = this;
        that.isFocus = false;
        that.execConstraint('onBlur', false);
        that.setValue(true);
        that.triggerEvent('onBlur', that.value);
    };

    classProto.iconEvent = function(e){
        var that = this,
            value = that.nodes['content']['input'].value;
        cm.preventDefault(e);
        that.nodes['content']['input'].setSelectionRange(0, value.length);
        that.focus();
    };

    /*** CONSTRAINT ***/

    classProto.addConstraint = function(eventName, handler){
        var that = this;
        if(cm.isFunction(handler)){
            that.constraints[eventName] = handler;
        }
        return that;
    };

    classProto.removeConstraint = function(eventName, handler){
        var that = this;
        that.constraints[eventName] = null;
        return that;
    };

    classProto.execConstraint = function(eventName, triggerEvents){
        var that = this,
            selectionStart,
            value,
            valueBounded;
        triggerEvents = cm.isUndefined(triggerEvents)? true : triggerEvents;
        if(cm.isFunction(that.constraints[eventName])){
            selectionStart = that.nodes['content']['input'].selectionStart;
            value = that.nodes['content']['input'].value;
            valueBounded = that.constraints[eventName](value);
            // Set bounded value
            that.nodes['content']['input'].value = that.constraints[eventName](value);
            // Restore caret position
            if(value.indexOf(valueBounded) > -1 || value === valueBounded){
                that.nodes['content']['input'].setSelectionRange(selectionStart, selectionStart);
            }else{
                that.nodes['content']['input'].setSelectionRange(that.selectionStartInitial, that.selectionStartInitial);
            }
            // Trigger events
            if(triggerEvents){
                switch(eventName){
                    case 'onInput':
                        that.selectValue(true);
                        break;
                    case 'onChange':
                        that.setValue(true);
                        break;
                }
            }
        }
        return that;
    };

    /*** DATA VALUE ***/

    classProto.lazyValue = function(triggerEvents){
        var that = this;
        triggerEvents = cm.isUndefined(triggerEvents)? true : triggerEvents;
        that.lazyDelay && clearTimeout(that.lazyDelay);
        that.lazyDelay = setTimeout(function(){
            triggerEvents && that.setValue(true);
        }, that.params['delay']);
    };

    classProto.setValue = function(triggerEvents){
        var that = this,
            value = that.nodes['content']['input'].value;
        triggerEvents = cm.isUndefined(triggerEvents)? true : triggerEvents;
        that.set(value, triggerEvents);
        return that;
    };

    classProto.selectValue = function(triggerEvents){
        var that = this,
            value = that.nodes['content']['input'].value;
        triggerEvents = cm.isUndefined(triggerEvents)? true : triggerEvents;
        that.selectAction(value, triggerEvents);
        return that;
    };

    classProto.setData = function(value){
        var that = this;
        that.nodes['content']['input'].value = !cm.isUndefined(value) ? value : that.value;
        return that;
    };

    /******* PUBLIC *******/

    classProto.focus = function(){
        var that = this;
        that.nodes['content']['input'].focus();
        return that;
    };

    classProto.blur = function(){
        var that = this;
        that.nodes['content']['input'].blur();
        return that;
    };

    classProto.toggleError = function(value){
        var that = this;
        if(value === true){
            cm.addClass(that.nodes['content']['input'], 'input-error');
        }else {
            cm.removeClass(that.nodes['content']['input'], 'input-error');
        }
        return that;
    };
});

/* ****** FORM FIELD COMPONENT ******* */

Com.FormFields.add('input', {
    'node' : cm.node('input', {'type' : 'text', 'class' : 'input'}),
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'text'
    }
});

Com.FormFields.add('textarea', {
    'node' : cm.node('textarea', {'class' : 'input textarea'}),
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'textarea'
    }
});

Com.FormFields.add('password', {
    'node' : cm.node('input', {'type' : 'password', 'class' : 'input'}),
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'password'
    }
});

Com.FormFields.add('email', {
    'node' : cm.node('input', {'type' : 'email', 'class' : 'input'}),
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'email'
    }
});

Com.FormFields.add('phone', {
    'node' : cm.node('input', {'type' : 'phone', 'class' : 'input'}),
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'phone'
    }
});

Com.FormFields.add('number', {
    'node' : cm.node('input', {'type' : 'number', 'class' : 'input'}),
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'number'
    }
});

Com.FormFields.add('hidden', {
    'node' : cm.node('input', {'type' : 'hidden'}),
    'visible' : false,
    'adaptive' : false,
    'value' : '',
    'defaultValue' : '',
    'fieldConstructor' : 'Com.AbstractFormField',
    'constructor' : 'Com.Input',
    'constructorParams' : {
        'type' : 'hidden'
    }
});
