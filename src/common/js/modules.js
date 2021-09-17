/******* EXTEND *******/

Mod.Extend = {
    '_config': {
        extend: true,
        predefine: true,
    },
    '_construct': function() {
    },
    '_extend': function(name, o) {
        const that = this;
        if (!that.build._modules[name]) {
            // Merge Config
            o._config = cm.merge({
                extend: false,
                predefine: false,
                require: [],
                events: [],
            }, o._config);
            // Check Requires
            cm.forEach(o._config.require, module => {
                if (Mod[module]) {
                    Mod.Extend._extend.call(that, module, Mod[module]);
                }
            });
            // Extend class by module's methods
            if (o._config.extend) {
                cm.forEach(o, (item, key) => {
                    if (!/^(_)/.test(key)) {
                        that.build[key] = item;
                    }
                });
            }
            // Extend class events
            if (!cm.isEmpty(o._config.events)) {
                that.build._raw.events = cm.extend(that.build._raw.events, o._config.events);
            }
            // Construct module
            if (cm.isFunction(o._construct)) {
                // Construct
                o._construct.call(that);
            } else {
                cm.errorLog({
                    type: 'error',
                    name: that.build._name.full,
                    message: `Module ${ cm.strWrap(name, '"') } does not have "_construct" method.`
                });
            }
            // Add into stack of class's modules
            that.build._modules[name] = o;
        }
    },
    'extend': function(name, o) {
        const that = this;
        if (!o) {
            cm.errorLog({
                type: 'error',
                name: that._name.full,
                message: 'Trying to extend the class by non-existing module.',
            });
        } else if (!name) {
            cm.errorLog({
                type: 'error',
                name: that._name.full,
                message: 'Module should have a name.',
            });
        } else if (that._modules[name]) {
            cm.errorLog({
                type: 'error',
                name: that._name.full,
                message: `Module with name ${ cm.strWrap(name, '"') } already constructed.`
            });
        } else {
            // Merge Config
            o._config = cm.merge({
                extend: false,
                predefine: false,
                require: [],
                events: [],
            }, o._config);
            // Check Requires
            cm.forEach(o._config.require, module => {
                if (Mod[module]) {
                    Mod.Extend._extend.call(that, module, Mod[module]);
                }
            });
            // Extend class by module's methods
            if (o._config.extend) {
                cm.forEach(o, (item, key) => {
                    if (!/^(_)/.test(key)) {
                        cm._defineStack[that._name.full].prototype[key] = item;
                    }
                });
            }
            // Extend events
            if (!cm.isEmpty(o._config.events)) {
                cm._defineStack[that._name.full].prototype._raw.events = cm.extend(cm._defineStack[that._name.full].prototype._raw.events, o._config.events);
            }
            // Construct module
            if (cm.isFunction(o._construct)) {
                // Construct
                o._construct.call(that);
            } else {
                cm.errorLog({
                    type: 'error',
                    name: that._name.full,
                    message: `Module ${ cm.strWrap(name, '"') } does not have "_construct" method.`
                });
            }
            // Add into stack of class's modules
            that._modules[name] = o;
        }
    },
};

/******* COMPONENTS *******/

Mod.Component = {
    '_config': {
        extend: true,
        predefine: true,
    },
    '_construct': function() {
        const that = this;
        that.build._isComponent = true;
    },
    'renderComponent': function() {
        const that = this;
        cm.forEach(that._modules, module => {
            cm.isFunction(module._render) && module._render.call(that);
        });
    },
    'cloneComponent': function(params) {
        const that = this;
        let component;
        cm.getConstructor(that._className, classConstructor => {
            component = new classConstructor(
                cm.merge(that.params, params),
            );
        });
        return component;
    },
};

/******* PARAMS *******/

Mod.Params = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
        events: ['onSetParams'],
    },
    '_construct': function() {
        const that = this;
        if (!that.build.params) {
            that.build.params = {};
        }
        if (!that.build._update.params) {
            that.build._update.params = {};
        }
        if (that.build._inherit) {
            that.build.params = cm.merge(that.build._inherit.prototype.params, that.build.params);
        }
    },
    '_render': function() {
        const that = this;
        if (that._inherit) {
            that.params = cm.merge(that._inherit.prototype.params, that.params);
        }
    },
    'setParams': function(params, replace) {
        const that = this;
        replace = cm.isUndefined(replace) ? false : replace;
        that.params = cm.merge(replace ? that._raw.params : that.params, params);
        that._params = replace ? params : cm.merge(that._params, params);
        that._update = cm.clone(that._update);
        that._update.params = cm.merge(that._update.params, that.params);
        // Validate params
        cm.forEach(that.params, (item, key) => {
            switch (key) {
                case 'messages':
                    cm.isFunction(that.setMessages) && that.setMessages(item);
                    break;

                default:
                    switch (item) {
                        case 'document.window':
                            that.params[key] = window;
                            break;

                        case 'document.html':
                            if (cm.getDocumentHtml()) {
                                that.params[key] = cm.getDocumentHtml();
                            }
                            break;

                        case 'document.body':
                            if (document.body) {
                                that.params[key] = document.body;
                            }
                            break;

                        case 'document.head':
                            if (cm.getDocumentHead()) {
                                that.params[key] = cm.getDocumentHead();
                            }
                            break;

                        default:
                            if (/^cm._config./i.test(item)) {
                                that.params[key] = cm._config[item.replace('cm._config.', '')];
                            }
                            break;
                    }
                    break;
            }
        });
        // Trigger event if module defined
        if (that._modules.Events) {
            that.triggerEvent('onSetParams');
        }
        return that;
    },
    'getParams': function(key) {
        const that = this;
        return key ? that.params[key] : that.params;
    },
    'getRawParams': function(key) {
        const that = this;
        return key ? that._raw.params[key] : that._raw.params;
    },
};

/******* EVENTS *******/

Mod.Events = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        that.build.events = {};
        cm.forEach(that.build._raw.events, (item) => {
            that.build.events[item] = [];
        });
        if (!that.build.params.events) {
            that.build.params.events = {};
        }
        if (that.build._inherit) {
            that.build.params.events = cm.extend(that.build._inherit.prototype.params.events, that.build.params.events, true);
            that.build.events = cm.extend(that.build._inherit.prototype.events, that.build.events, true);
        }
    },
    '_render': function() {
        const that = this;
        if (that._inherit) {
            that.params.events = cm.extend(that._inherit.prototype.params.events, that.params.events, true);
            that.events = cm.extend(that._inherit.prototype.events, that.events, true);
        }
    },
    'addEvent': function(event, handler) {
        const that = this;
        that.events = cm.clone(that.events);
        if (that.events[event]) {
            if (cm.isFunction(handler)) {
                that.events[event].push(handler);
            } else {
                cm.errorLog({
                    name: that._name.full,
                    message: `Handler of event ${ cm.strWrap(event, '"') } must be a function.`
                });
            }
        } else {
            cm.errorLog({
                type: 'attention',
                name: that._name.full,
                message: `${ cm.strWrap(event, '"') } does not exists.`
            });
        }
        return that;
    },
    'addEvents': function(o) {
        const that = this;
        if (o) {
            that.convertEvents(o);
        }
        return that;
    },
    'removeEvent': function(event, handler) {
        const that = this;
        that.events = cm.clone(that.events);
        if (that.events[event]) {
            if (cm.isFunction(handler)) {
                that.events[event] = that.events[event].filter(item => item !== handler);
            } else {
                cm.errorLog({
                    name: that._name.full,
                    message: `Handler of event ${ cm.strWrap(event, '"') } must be a function.`
                });
            }
        } else {
            cm.errorLog({
                type: 'attention',
                name: that._name.full,
                message: `${ cm.strWrap(event, '"') } does not exists.`
            });
        }
        return that;
    },
    'removeAllEvent': function(event) {
        const that = this;
        that.events = cm.clone(that.events);
        if (that.events[event]) {
            that.events = [];
        } else {
            cm.errorLog({
                type: 'attention',
                name: that._name.full,
                message: `${ cm.strWrap(event, '"') } does not exists.`
            });
        }
        return that;
    },
    'triggerEvent': function(event, params) {
        const that = this;
        let data = cm.clone(arguments);
        // Replace event name parameter with context (legacy) in data
        data[0] = that;
        if (that.events[event]) {
            let events = cm.clone(that.events[event]);
            cm.forEach(events, event => {
                event.apply(that, data);
            });
        } else {
            cm.errorLog({
                type: 'attention',
                name: that._name.full,
                message: `${ cm.strWrap(event, '"') } does not exists.`
            });
        }
        return that;
    },
    'hasEvent': function(event) {
        const that = this;
        return !!that.events[event];
    },
    'convertEvents': function(o) {
        const that = this;
        cm.forEach(o, (item, key) => {
            if (cm.isArray(item)) {
                cm.forEach(item, itemA => {
                    that.addEvent(key, itemA);
                });
            } else {
                that.addEvent(key, item);
            }
        });
        return that;
    },
};

/******* MESSAGES ******* */

Mod.Messages = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (!that.build.messages) {
            that.build.messages = {};
        }
        if (!that.build.params.messages) {
            that.build.params.messages = {};
        }
    },
    '_render': function() {
        const that = this;
        that.messages = cm.merge(that.messages, that.params.messages);
    },
    'message': function(str, vars, plural) {
        const that = this;
        if (cm.isUndefined(str) || cm.isEmpty(str)) {
            return '';
        }
        // Get message
        let message = that.getMessage(str);
        if (cm.isUndefined(message)) {
            message = str;
        }
        // Process variable
        if (cm.isObject(message) || cm.isArray(message)) {
            message = cm.objectReplace(message, vars);
        } else {
            message = cm.strReplace(message, vars);
        }
        // Plural
        if (!cm.isUndefined(plural) && cm.isArray(message)) {
            message = cm.plural(plural, message);
        }
        return message;
    },
    'msg': function() {
        const that = this;
        return that.message.apply(that, arguments);
    },
    'getMessage': function(str) {
        const that = this;
        if (cm.isUndefined(str) || cm.isEmpty(str)) {
            return;
        }
        // Try to get string from current controller params array
        let message = cm.reducePath(str, that.params.messages);
        // Try to get string from current controller messages array
        if (cm.isUndefined(message)) {
            message = cm.reducePath(str, that.messages);
        }
        // Try to get string from parent controller
        if (cm.isUndefined(message) && that._inherit) {
            message = that._inherit.prototype.getMessage(str);
        }
        return message;
    },
    'getMsg': function() {
        const that = this;
        return that.getMessage.apply(that, arguments);
    },
    'messageObject': function(str) {
        const that = this;
        const o = that.message(str);
        return cm.isObject(o) || cm.isArray(o) ? o : {};
    },
    'msgObject': function() {
        const that = this;
        return that.messageObject.apply(that, arguments);
    },
    'setMessages': function(o) {
        const that = this;
        if (cm.isObject(o)) {
            if (cm.isFunction(that)) {
                that.prototype.messages = cm.merge(that.prototype.messages, o);
            } else {
                that.messages = cm.merge(that.messages, o);
            }
        }
        return that;
    },
    'setMsgs': function() {
        const that = this;
        return that.setMessages.apply(that, arguments);
    },
};

/******* DATA CONFIG *******/

Mod.DataConfig = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (cm.isUndefined(that.build.params.configDataMarker)) {
            that.build.params.configDataMarker = 'data-config';
        }
    },
    'getDataConfig': function(container, dataMarker) {
        const that = this;
        if (cm.isNode(container)) {
            dataMarker = dataMarker || that.params.configDataMarker;
            let sourceConfig = container.getAttribute(dataMarker);
            if (sourceConfig && (sourceConfig = cm.parseJSON(sourceConfig))) {
                that.setParams(sourceConfig);
            }
        }
        return that;
    },
    'getNodeDataConfig': function(node, dataMarker) {
        const that = this;
        if (cm.isNode(node)) {
            dataMarker = dataMarker || that.params.configDataMarker;
            let sourceConfig = node.getAttribute(dataMarker);
            if (sourceConfig && (sourceConfig = cm.parseJSON(sourceConfig))) {
                return sourceConfig;
            }
        }
        return {};
    },
};

/******* DATA NODES *******/

Mod.DataNodes = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (!that.build.params.nodes) {
            that.build.params.nodes = {};
        }
        that.build.params.nodesDataMarker = 'data-node';
        that.build.params.nodesMarker = that.build._name.short;
        if (!that.build.nodes) {
            that.build.nodes = {};
        }
        if (that.build._inherit) {
            that.build.params.nodes = cm.merge(that.build._inherit.prototype.params.nodes, that.build.params.nodes);
            that.build.nodes = cm.merge(that.build._inherit.prototype.nodes, that.build.nodes);
        }
    },
    'getDataNodes': function(container, dataMarker, className) {
        const that = this;
        let sourceNodes = {};
        container = cm.isUndefined(container) ? document.body : container;
        if (container) {
            dataMarker = cm.isUndefined(dataMarker) ? that.params.nodesDataMarker : dataMarker;
            className = cm.isUndefined(className) ? that.params.nodesMarker : className;
            if (className) {
                sourceNodes = cm.getNodes(container, dataMarker)[className] || {};
            } else {
                sourceNodes = cm.getNodes(container, dataMarker);
            }
            that.nodes = cm.merge(that.nodes, sourceNodes);
        }
        that.nodes = cm.merge(that.nodes, that.params.nodes);
        return that;
    },
    'getDataNodesObject': function(container, dataMarker, className) {
        const that = this;
        container = typeof container === 'undefined' ? document.body : container;
        dataMarker = typeof dataMarker === 'undefined' ? that.params.nodesDataMarker : dataMarker;
        className = typeof className === 'undefined' ? that.params.nodesMarker : className;
        let sourceNodes;
        if (className) {
            sourceNodes = cm.getNodes(container, dataMarker)[className] || {};
        } else {
            sourceNodes = cm.getNodes(container, dataMarker);
        }
        return sourceNodes;
    },
};

/******* LOCAL STORAGE *******/

Mod.Storage = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (!that.build.params.name) {
            that.build.params.name = '';
        }
    },
    'storageGet': function(key, session) {
        const that = this;
        const method = session ? 'sessionStorageGet' : 'storageGet';
        let storage = JSON.parse(cm[method](that._className)) || {};
        if (cm.isEmpty(that.params.name)) {
            cm.errorLog({
                type: 'error',
                name: that._className,
                message: 'Storage cannot be read because "name" parameter not provided.',
            });
            return;
        }
        if (!storage[that.params.name] || cm.isUndefined(storage[that.params.name][key])) {
            cm.errorLog({
                type: 'attention',
                name: that._className,
                message: `Parameter ${ cm.strWrap(key, '"') } does not exist or is not set in component with name ${ cm.strWrap(that.params.name, '"') }.`
            });
            return;
        }
        return storage[that.params.name][key];
    },
    'storageGetAll': function(session) {
        const that = this;
        const method = session ? 'sessionStorageGet' : 'storageGet';
        let storage = JSON.parse(cm[method](that._className)) || {};
        if (cm.isEmpty(that.params.name)) {
            cm.errorLog({
                type: 'error',
                name: that._className,
                message: 'Storage cannot be read because "name" parameter not provided.',
            });
            return {};
        }
        if (!storage[that.params.name]) {
            cm.errorLog({
                type: 'attention',
                name: that._className,
                message: 'Storage is empty.',
            });
            return {};
        }
        return storage[that.params.name];
    },
    'storageSet': function(key, value, session) {
        const that = this;
        // Read
        const methodGet = session ? 'sessionStorageGet' : 'storageGet';
        let storage = JSON.parse(cm[methodGet](that._className)) || {};
        if (cm.isEmpty(that.params.name)) {
            cm.errorLog({
                type: 'error',
                name: that._className,
                message: 'Storage cannot be written because "name" parameter not provided.',
            });
            return {};
        }
        if (!storage[that.params.name]) {
            storage[that.params.name] = {};
        }
        storage[that.params.name][key] = value;
        // Write
        const methodSet = session ? 'sessionStorageSet' : 'storageSet';
        cm[methodSet](that._className, JSON.stringify(storage));
        return storage[that.params.name];
    },
    'storageSetAll': function(data, session) {
        const that = this;
        // Read
        const methodGet = session ? 'sessionStorageGet' : 'storageGet';
        let storage = JSON.parse(cm[methodGet](that._className)) || {};
        if (cm.isEmpty(that.params.name)) {
            cm.errorLog({
                type: 'error',
                name: that._className,
                message: 'Storage cannot be written because "name" parameter not provided.',
            });
            return {};
        }
        storage[that.params.name] = data;
        // Write
        const methodSet = session ? 'sessionStorageSet' : 'storageSet';
        cm[methodSet](that._className, JSON.stringify(storage));
        return storage[that.params.name];
    },
    'storageRemove': function(key, session) {
        const that = this;
        // Read
        const methodGet = session ? 'sessionStorageGet' : 'storageGet';
        let storage = JSON.parse(cm[methodGet](that._className)) || {};
        if (cm.isEmpty(that.params.name)) {
            cm.errorLog({
                type: 'error',
                name: that._className,
                message: 'Storage cannot be written because "name" parameter not provided.',
            });
            return {};
        }
        if (!storage[that.params.name]) {
            storage[that.params.name] = {};
        }
        delete storage[that.params.name][key];
        // Write
        const methodSet = session ? 'sessionStorageSet' : 'storageSet';
        cm[methodSet](that._className, JSON.stringify(storage));
        return storage[that.params.name];
    },
};

/******* CALLBACKS *******/

Mod.Callbacks = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (!that.build.params.callbacks) {
            that.build.params.callbacks = {};
        }
        that.build.callbacks = {};
        that.build._callbacks = {};
        if (that.build._inherit) {
            that.build.params.callbacks = cm.extend(that.build._inherit.prototype.params.callbacks, that.build.params.callbacks);
            that.build.callbacks = cm.extend(that.build._inherit.prototype.callbacks, that.build.callbacks);
        }
    },
    '_render': function() {
        const that = this;
        if (that._inherit) {
            that.params.callbacks = cm.merge(that._inherit.prototype.params.callbacks, that.params.callbacks);
            that.callbacks = cm.extend(that._inherit.prototype.callbacks, that.callbacks);
        }
    },
    'callbacksProcess': function() {
        const that = this;
        that.callbacks = cm.clone(that.callbacks);
        // Save default callbacks
        cm.forEach(that.callbacks, (callback, name) => {
            that._callbacks[name] = callback;
        });
        // Replace callbacks
        cm.forEach(that.params.callbacks, (callback, name) => {
            that.callbacks[name] = callback;
        });
        return that;
    },
    'callbacksRestore': function() {
        const that = this;
        that.callbacks = cm.clone(that.callbacks);
        cm.forEach(that._callbacks, (callback, name) => {
            that.callbacks[name] = callback;
        });
        return that;
    },
};

/* ******* STACK ******* */

Mod.Stack = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (!that.build.params.name) {
            that.build.params.name = '';
        }
        that.build._stack = [];
    },
    'addToStack': function(node) {
        const that = this;
        const name = cm.isNumber(that.params.name) ? that.params.name.toString() : that.params.name;
        if (!that._stackItem) {
            that._stackItem = {
                name: name,
                node: node,
                class: that,
                className: that._name.full,
            };
            that._stack.push(that._stackItem);
        } else if (cm.isNode(node)) {
            that._stackItem.node = node;
        }
        return that;
    },
    'removeFromStack': function() {
        const that = this;
        cm.arrayRemove(that._stack, that._stackItem);
        that._stackItem = null;
        return that;
    },
    'isAppropriateToStack': function(name, parent, callback) {
        const that = this;
        const item = that._stackItem;
        name = cm.isNumber(name) ? name.toString() : name;
        callback = cm.isFunction(callback) ? callback : () => {};
        if (
            (cm.isEmpty(name) || item.name === name)
            && (cm.isEmpty(parent) || cm.isParent(parent, item.node, true))
        ) {
            callback(item.class, item, name);
            return true;
        }
        return false;
    },
    'findInStack': function(name, parent, callback) {
        const that = this;
        name = cm.isNumber(name) ? name.toString() : name;
        callback = cm.isFunction(callback) ? callback : () => {};
        let items = [];
        cm.forEach(that._stack, item => {
            if (
                (cm.isEmpty(name) || item.name === name)
                && (cm.isEmpty(parent) || cm.isParent(parent, item.node, true))
            ) {
                items.push(item);
                callback(item.class, item, name);
            }
        });
        return items;
    },
    'getStackNode': function() {
        const that = this;
        return that._stackItem ? that._stackItem.node : null;
    },
};

/****** STRUCTURE *******/

Mod.Structure = {
    '_config': {
        extend: true,
        predefine: false,
        require: ['Extend'],
    },
    '_construct': function() {
        const that = this;
        if (cm.isUndefined(that.build.params.renderStructure)) {
            that.build.params.renderStructure = true;
        }
        if (cm.isUndefined(that.build.params.embedStructure)) {
            that.build.params.embedStructure = 'append';
        }
    },
    'embedStructure': function(node, container) {
        const that = this;
        switch (that.params.embedStructure) {
            case 'replace':
                that.replaceStructure(node);
                break;
            case 'append':
            case 'last':
                that.appendStructure(node, 'insertLast', container);
                break;
            case 'prepend':
            case 'first':
                that.appendStructure(node, 'insertFirst', container);
                break;
        }
        return that;
    },
    'appendStructure': function(node, type, container) {
        const that = this;
        container = container || that.params.container || that.params.node;
        container && cm[type](node, container);
        return that;
    },
    'replaceStructure': function(node, container) {
        const that = this;
        container = container || that.params.container;
        if (container) {
            if (that.params.container === that.params.node) {
                cm.insertBefore(node, that.params.node);
            } else {
                that.params.container.appendChild(node);
            }
        } else if (that.params.node) {
            cm.insertBefore(node, that.params.node);
        }
        cm.remove(that.params.node);
        return that;
    },
};
