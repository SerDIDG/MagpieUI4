cm._defineStack = {};
cm._defineExtendStack = {};

cm.defineHelper = function(name, data, handler) {
    const that = this;
    // Process config
    data = cm.merge({
        modules: [],
        require: [],
        params: {},
        events: [],
        extend: false,
    }, data);
    // Create class extend object
    that.build = {
        constructor: handler,
        _raw: cm.clone(data),
        _update: {},
        _name: {
            full: name,
            short: name.replace('.', ''),
            split: name.split('.'),
        },
        _className: name,
        _constructor: handler,
        _modules: {},
        params: data.params,
        messages: data.messages,
    };
    // Inheritance
    if (data.extend) {
        cm.getConstructor(data.extend, (classConstructor, className) => {
            handler.prototype = Object.create(classConstructor.prototype);
            that.build._inheritName = className;
            that.build._inherit = classConstructor;
            // Merge raw params
            that.build._raw.modules = cm.merge(that.build._inherit.prototype._raw.modules, that.build._raw.modules);
            that.build._raw.events = cm.merge(that.build._inherit.prototype._raw.events, that.build._raw.events);
            // Add to extend stack
            if (cm._defineExtendStack[className]) {
                cm._defineExtendStack[className].push(name);
            }
        });
    }
    // Extend class by predefine modules
    cm.forEach(Mod, (module, name) => {
        if (module._config && module._config.predefine) {
            Mod.Extend._extend.call(that, name, module);
        }
    });
    // Extend class by class specific modules
    cm.forEach(that.build._raw.modules, (module) => {
        if (Mod[module]) {
            Mod.Extend._extend.call(that, module, Mod[module]);
        }
    });
    // Prototype class methods
    cm.forEach(that.build, (value, key) => {
        handler.prototype[key] = value;
    });
    // Add to stack
    if (!cm._defineExtendStack[name]) {
        cm._defineExtendStack[name] = [];
    }
    cm._defineStack[name] = handler;
    // Extend Window object
    cm.objectSelector(name, window, handler);
};

cm.define = (function() {
    const definer = Function.prototype.call.bind(cm.defineHelper, arguments);
    return function() {
        definer.apply(cm.defineHelper, arguments);
    };
})();

cm.getConstructor = function(className, callback) {
    callback = cm.isFunction(callback) ? callback : () => {};
    if (cm.isUndefined(className)) {
        cm.errorLog({
            type: 'error',
            name: 'cm.getConstructor',
            message: 'Parameter "className" does not specified.',
        });
        return null;
    } else if (className === '*') {
        cm.forEach(cm._defineStack, classConstructor => {
            callback(classConstructor, className, classConstructor.prototype, classConstructor.prototype._inherit);
        });
        return cm._defineStack;
    } else {
        let classConstructor = cm._defineStack[className];
        if (!classConstructor) {
            cm.errorLog({
                type: 'attention',
                name: 'cm.getConstructor',
                message: `Class ${ cm.strWrap(className, '"') } does not exists or define.`,
            });
            return null;
        } else {
            callback(classConstructor, className, classConstructor.prototype, classConstructor.prototype._inherit);
            return classConstructor;
        }
    }
};

cm.isInstance = function(childClass, parentClass) {
    let isInstance = false;
    if (cm.isString(parentClass)) {
        parentClass = cm.getConstructor(parentClass);
    }
    if (!cm.isEmpty(childClass) && !cm.isEmpty(parentClass)) {
        isInstance = childClass instanceof parentClass;
    }
    return isInstance;
};

cm.find = function(className, name, parentNode, callback, params) {
    let items = [];
    let processed = {};
    // Config
    callback = cm.isFunction(callback) ? callback : () => {};
    params = cm.merge({
        children: false,
    }, params);
    // Process
    if (!className || className === '*') {
        cm.forEach(cm._defineStack, classConstructor => {
            if (classConstructor.prototype.findInStack) {
                items = cm.extend(items, classConstructor.prototype.findInStack(name, parentNode, callback));
            }
        });
    } else {
        const classConstructor = cm._defineStack[className];
        if (!classConstructor) {
            cm.errorLog({
                type: 'error',
                name: 'cm.find',
                message: `Class ${ cm.strWrap(className, '"') } does not exist.`,
            });
        } else if (!classConstructor.prototype.findInStack) {
            cm.errorLog({
                type: 'error',
                name: 'cm.find',
                message: `Class ${ cm.strWrap(className, '"') } does not support Module Stack.`,
            });
        } else {
            // Find instances of current constructor
            items = cm.extend(items, classConstructor.prototype.findInStack(name, parentNode, callback));
            // Find child instances, and stack processed parent classes to avoid infinity loops
            if (params.children && cm._defineExtendStack[className] && !processed[className]) {
                processed[className] = true;
                cm.forEach(cm._defineExtendStack[className], childName => {
                    items = cm.extend(items, cm.find(childName, name, parentNode, callback, params));
                });
            }
        }
    }
    return items;
};

cm.Finder = function(className, name, parentNode, callback, params) {
    const that = this;
    let isEventBind = false;

    function init() {
        // Merge params
        callback = cm.isFunction(callback) ? callback : () => {};
        params = cm.merge({
            event: 'onRender',
            multiple: false,
            children: false,
        }, params);
        // Search in constructed classes
        const finder = cm.find(className, name, parentNode, callback, {
            children: params.children,
        });
        // Bind event when no one constructed class found
        if (!finder || !finder.length || params.multiple) {
            isEventBind = true;
            cm.getConstructor(className, classConstructor => {
                classConstructor.prototype.addEvent(params.event, watcher);
            });
        }
    }

    function watcher(classObject) {
        classObject.removeEvent(params.event, watcher);
        const isSame = classObject.isAppropriateToStack(name, parentNode, callback);
        if (isSame && !params.multiple && isEventBind) {
            that.remove(classObject._constructor);
        }
    }

    that.remove = function(classConstructor) {
        if (classConstructor) {
            classConstructor.prototype.removeEvent(params.event, watcher);
        } else {
            cm.getConstructor(className, classConstructor => {
                classConstructor.prototype.removeEvent(params.event, watcher);
            });
        }
    };

    init();
};

cm.setParams = function(className, params) {
    cm.getConstructor(className, (classConstructor, className, classProto) => {
        classProto.setParams(params);
    });
};

cm.setMessages = function(className, messages) {
    cm.getConstructor(className, (classConstructor, className, classProto) => {
        classProto.setMessages(messages);
    });
};

cm.getMessage = function(className, str) {
    let data;
    cm.getConstructor(className, (classConstructor, className, classProto) => {
        data = classProto.message(str);
    });
    return data;
};

cm.getMessages = function(className, o) {
    let data;
    cm.getConstructor(className, (classConstructor, className, classProto) => {
        data = classProto.messageObject(o);
    });
    return data;
};
