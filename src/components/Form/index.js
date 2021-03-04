cm.define('Com.Form', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Storage',
        'Callbacks',
        'Stack',
        'Structure'
    ],
    'events' : [
        'onRenderStart',
        'onRender',
        'onValidate',
        'onError',
        'onAbort',
        'onSuccess',
        'onSendStart',
        'onSend',
        'onSendEnd',
        'onSet',
        'onChange',
        'onInput',
        'onClear',
        'onReset'
    ],
    'params' : {
        'node' : cm.node('div'),
        'container' : null,
        'name' : '',
        'renderStructure' : true,
        'embedStructure' : 'append',
        'removeOnDestruct' : true,
        'renderButtons' : true,
        'renderButtonsSeparator' : true,
        'buttonsAlign' : 'right',
        'renderNames' : false,                                      // Render visual input name attribute
        'showLoader' : true,
        'loaderCoverage' : 'fields',                                // fields, all
        'showNotifications' : true,
        'showSuccessNotification' : false,
        'showValidationNotification' : false,
        'showValidationMessages' : true,
        'responseKey': 'data',
        'responseErrorsKey': 'errors',
        'responseMessageKey' : 'message',
        'responseCodeKey' : 'code',
        'validate' : false,
        'validateOnChange' : false,
        'validateOnInput' : false,
        'sendEmptyFields' : false,
        'sendOnlyChangedFields' : false,
        'data' : {},
        'request' : {
            'type' : 'json',
            'method' : 'post',
            'formData' : true,
            'url' : '',                                             // Request URL. Variables: %baseUrl%, %callback% for JSONP.
            'params' : ''                                           // Params object. %baseUrl%, %callback% for JSONP.
        },
        'Com.Notifications' : {},
        'overlayConstructor' : 'Com.Overlay',
        'overlayParams' : {
            'position' : 'absolute',
            'autoOpen' : false,
            'removeOnClose' : true,
            'lazy' : true
        }
    }
},
function(params){
    var that = this;

    that.nodes = {};
    that.components = {};
    that.fields = {};
    that.buttons = {};
    that.constraints = [];
    that.requestHandler = null;

    that.isRequest = false;
    that.isProcess = false;

    var init = function(){
        that.renderComponent();
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        that.callbacksProcess();
        that.addToStack(that.params['node']);
        that.triggerEvent('onRenderStart');
        validateParams();
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var validateParams = function(){
        that.params['buttonsAlign'] = cm.inArray(['left', 'center', 'right', 'justify'], that.params['buttonsAlign']) ? that.params['buttonsAlign'] : 'right';
        that.params['loaderCoverage'] = cm.inArray(['fields', 'all'], that.params['loaderCoverage']) ? that.params['loaderCoverage'] : 'all';
        // Request
        that.isRequest = that.params['request'] && !cm.isEmpty(that.params['request']['url']);
    };

    var render = function(){
        var overlayContainer;
        // Structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.node('div', {'class' : 'com__form'},
                that.nodes['fieldsContainer'] = cm.node('div', {'class' : 'com__form__fields'},
                    that.nodes['fields'] = cm.node('div', {'class' : 'inner'})
                )
            );
            // Notifications
            that.nodes['notifications'] = cm.node('div', {'class' : 'com__form__notifications'});
            // Buttons
            that.nodes['buttonsSeparator'] = cm.node('hr');
            that.nodes['buttonsContainer'] = cm.node('div', {'class' : 'com__form__buttons'},
                that.nodes['buttons'] = cm.node('div', {'class' : 'pt__buttons is-adaptive'},
                    that.nodes['buttonsHolder'] = cm.node('div', {'class' : 'inner'})
                )
            );
            cm.addClass(that.nodes['buttons'], ['pull', that.params['buttonsAlign']].join('-'));
            // Embed
            that.params['renderButtonsSeparator'] && cm.insertFirst(that.nodes['buttonsSeparator'], that.nodes['buttonsContainer']);
            that.params['renderButtons'] && cm.appendChild(that.nodes['buttonsContainer'], that.nodes['container']);
            cm.insertFirst(that.nodes['notifications'], that.nodes['container']);
            that.embedStructure(that.nodes['container']);
        }
        // Notifications
        cm.getConstructor('Com.Notifications', function(classConstructor, className){
            that.components['notifications'] = new classConstructor(
                cm.merge(that.params[className], {
                    'container' : that.nodes['notifications']
                })
            );
            that.components['notifications'].addEvent('onAdd', function(){
                cm.addClass(that.nodes['notifications'], 'is-show', true);
            });
            that.components['notifications'].addEvent('onRemove', function(){
                if(that.components['notifications'].getLength() === 0){
                    cm.removeClass(that.nodes['notifications'], 'is-show', true);
                }
            });
        });
        // Overlay Loader
        if(that.params['showLoader']){
            cm.getConstructor(that.params['overlayConstructor'], function(classConstructor){
                switch(that.params['loaderCoverage']){
                    case 'fields':
                        overlayContainer = that.nodes['fieldsContainer'];
                        break;
                    case 'all':
                    default:
                        overlayContainer = that.nodes['container'];
                        break;
                }
                that.components['loader'] = new classConstructor(
                    cm.merge(that.params['overlayParams'], {
                        'container' : overlayContainer
                    })
                );
            });
        }
    };

    var renderField = function(type, params){
        var field = Com.FormFields.get(type);
        // Merge params
        params = cm.merge({
            'originValue' : null,
            'form' : that,
            'formName' : that.params['name'],
            'system' : false,
            'send' : true,
            'name' : '',
            'sendPath' : null,
            'label' : '',
            'required' : false,
            'validate' : false,
            'options' : [],
            'container' : that.nodes['fields'],
            'renderName' : null,
            'renderErrorMessage' : that.params['showValidationMessages']
        }, params);
        params = cm.merge(cm.clone(field, true), params);
        // Validate
        params['fieldConstructor'] = cm.isEmpty(params['fieldConstructor']) ? 'Com.FormField' : params['fieldConstructor'];
        params['value'] = that.params['data'][params['name']] || params['value'];
        params['dataValue'] = that.params['data'][params['dataName']] || params['dataValue'];
        params['renderName'] = cm.isBoolean(params['renderName']) ? params['renderName'] : that.params['renderNames'];
        // Render controller
        if(field && !that.fields[params['name']]){
            renderFieldController(params);
        }
    };

    var renderFieldController = function(params){
        cm.getConstructor(params['fieldConstructor'], function(classConstructor){
            params['fieldController'] = params['controller'] = new classConstructor(params);
            params['inputController'] = params['constructorController'] = cm.isFunction(params['fieldController'].getController) && params['fieldController'].getController();
            // Events
            params['fieldController'].addEvent('onBlur', function(field){
                if(that.params['validate'] && that.params['validateOnChange'] && (field.params['required'] || field.params['validate'])){
                    params['fieldController'].validate();
                }
            });
            params['fieldController'].addEvent('onChange', function(field){
                if(that.params['validate'] && that.params['validateOnChange'] && (field.params['required'] || field.params['validate'])){
                    params['fieldController'].validate();
                }
                that.triggerEvent('onChange');
            });
            params['fieldController'].addEvent('onInput', function(field){
                if(that.params['validate'] && that.params['validateOnInput'] && (field.params['required'] || field.params['validate'])){
                    params['fieldController'].validate();
                }
                that.triggerEvent('onInput');
            });
            // Save processed origin data to compare before send
            params['originValue'] = params['fieldController'].get();
            // Save
            that.fields[params['name']] = params;
        });
    };

    var renderButton = function(params){
        params = cm.merge({
            'name' : '',
            'label' : '',
            'class' : '',
            'spinner' : false,
            'spinnerClass' : '',
            'action' : 'submit',          // submit | reset | clear | custom
            'handler' : function(){}
        }, params);
        // Render
        if(!that.buttons[params['name']]){
            params['node'] = cm.node('button', {'name' : params['name'], 'class' : ['button', params['class']].join(' ')},
                params['labelNode'] = cm.node('div', {'class' : 'label is-show'}, params['label'])
            );
            // Spinner
            if(params['spinner']){
                params['spinnerNode'] = cm.node('div', {'class' : ['icon', params['spinnerClass']].join(' ')});
                cm.appendChild(params['spinnerNode'], params['node']);
                cm.addClass(params['node'], 'button-spinner');
            }
            // Actions
            switch(params['action']){
                case 'submit':
                    params['node'].type = 'submit';
                    cm.addClass(params['node'], 'button-primary');
                    cm.addEvent(params['node'], 'click', function(e){
                        cm.preventDefault(e);
                        if(that.isProcess){
                            that.abort();
                        }else{
                            that.send();
                        }
                    });
                    break;

                case 'reset':
                    params['node'].type = 'reset';
                    cm.addClass(params['node'], 'button-secondary');
                    cm.addEvent(params['node'], 'click', function(e){
                        cm.preventDefault(e);
                        if(!that.isProcess){
                            that.reset();
                        }
                    });
                    break;

                case 'clear':
                    cm.addClass(params['node'], 'button-secondary');
                    cm.addEvent(params['node'], 'click', function(e){
                        cm.preventDefault(e);
                        if(!that.isProcess){
                            that.clear();
                        }
                    });
                    break;

                case 'custom':
                default:
                    cm.addEvent(params['node'], 'click', function(e){
                        cm.preventDefault(e);
                        cm.isFunction(params['handler']) && params['handler'](that, params, e);
                    });
                    break;
            }
            cm.appendChild(params['node'], that.nodes['buttonsHolder']);
            // Export
            that.buttons[params['name']] = params;
        }
    };

    var toggleButtons = function(){
        cm.forEach(that.buttons, function(item){
            if(that.isProcess){
                if(item['spinner']){
                    cm.replaceClass(item['labelNode'], 'is-show', 'is-hide');
                    cm.replaceClass(item['spinnerNode'], 'is-hide', 'is-show');
                }
            }else{
                if(item['spinner']){
                    cm.replaceClass(item['labelNode'], 'is-hide', 'is-show');
                    cm.replaceClass(item['spinnerNode'], 'is-show', 'is-hide');
                }
            }
        });
    };

    var renderSeparator = function(params){
        params = cm.merge({
            'node' : cm.node('hr'),
            'container' : that.nodes['fields']
        }, params);
        cm.appendChild(params['node'], params['container']);
    };

    var removeField = function(name){
        var item = that.getField(name);
        if(item){
            item['fieldController'] && cm.isFunction(item['fieldController'].destruct) && item['fieldController'].destruct();
            delete that.fields[name];
        }
    };

    /* *** VALIDATE *** */

    var validateHelper = function(){
        var fieldParams,
            isFieldValidatable,
            constraintsData,
            testData,
            data = {
                'form' : that,
                'valid' : true,
                'message' : null
            };
        // Fields
        cm.forEach(that.fields, function(field, name){
            fieldParams = field['controller'].getParams();
            isFieldValidatable = field['field'] && !field['system'] && (fieldParams['required'] || fieldParams['validate']) && cm.isFunction(field['controller'].validate);
            if(isFieldValidatable && !field['controller'].validate()){
                data['message'] = that.lang('form_error');
                data['valid'] = false;
            }
        });
        // Constraints
        if(!cm.isEmpty(that.constraints)){
            testData = cm.clone(data);
            constraintsData = validateConstraints(testData);
            if(constraintsData){
                data = cm.merge(data, constraintsData);
            }
        }
        return data;
    };

    var validateConstraints = function(data){
        var constraintsTest,
            constraintsData;
        constraintsTest = that.constraints.some(function(item){
            if(cm.isFunction(item)){
                constraintsData = item(data);
                return !constraintsData['valid'];
            }
            return false;
        });
        if(constraintsTest){
            return constraintsData;
        }
        return false;
    };

    /* ******* CALLBACKS ******* */

    that.callbacks.prepare = function(that, config){
        config = that.callbacks.beforePrepare(that, config);
        config['url'] = cm.strReplace(config['url'], {
            '%baseUrl%' : cm._baseUrl
        });
        config['params'] = cm.objectReplace(config['params'], {
            '%baseUrl%' : cm._baseUrl
        });
        config['params'] = cm.merge(config['params'], that.get('sendPath'));
        config = that.callbacks.afterPrepare(that, config);
        return config;
    };

    that.callbacks.beforePrepare = function(that, config){
        return config;
    };

    that.callbacks.afterPrepare = function(that, config){
        return config;
    };

    that.callbacks.request = function(that, config){
        config = that.callbacks.prepare(that, config);
        that.callbacks.clearError(that);
        // Return ajax handler (XMLHttpRequest) to providing abort method.
        return cm.ajax(
            cm.merge(config, {
                'onStart' : function(){
                    that.callbacks.start(that, config);
                },
                'onSuccess' : function(response){
                    that.callbacks.response(that, config, response);
                },
                'onError' : function(response){
                    that.callbacks.error(that, config, response);
                },
                'onAbort' : function(){
                    that.callbacks.abort(that, config);
                },
                'onEnd' : function(response){
                    that.callbacks.end(that, config, response);
                }
            })
        );
    };

    that.callbacks.start = function(that, config){
        that.isProcess = true;
        cm.addClass(that.nodes['container'], 'is-submitting');
        // Toggle buttons
        toggleButtons();
        // Show Loader
        if(that.params['showLoader']){
            that.showLoader();
        }
        that.triggerEvent('onSendStart');
    };

    that.callbacks.end = function(that, config){
        that.isProcess = false;
        cm.removeClass(that.nodes['container'], 'is-submitting');
        // Toggle buttons
        toggleButtons();
        // Hide Loader
        if(that.params['showLoader']){
            that.hideLoader();
        }
        that.triggerEvent('onSendEnd');
    };

    that.callbacks.response = function(that, config, response){
        var errors,
            data;
        if(!cm.isEmpty(response)){
            errors = cm.objectSelector(that.params['responseErrorsKey'], response);
            data = cm.objectSelector(that.params['responseKey'], response);
            if(!cm.isEmpty(errors)){
                that.callbacks.error(that, config, response);
            }else{
                that.callbacks.success(that, data);
            }
        }else{
            that.callbacks.error(that, config);
        }
    };

    that.callbacks.error = function(that, config, response){
        var errors,
            message,
            code;
        if(!cm.isEmpty(response)){
            errors = cm.objectSelector(that.params['responseErrorsKey'], response);
            message = cm.objectSelector(that.params['responseMessageKey'], response);
            code = cm.objectSelector(that.params['responseCodeKey'], response);
        }
        that.callbacks.renderError(that, errors, message);
        that.triggerEvent('onError', {
            'response' : response,
            'errors' : errors,
            'message' : message,
            'code' : code
        });
    };

    that.callbacks.success = function(that, data){
        if(that.params['showNotifications'] && that.params['showSuccessNotification']){
            that.callbacks.renderNotification(that, {
                'label' : that.lang('success_message'),
                'type' : 'success'
            });
        }
        that.triggerEvent('onSuccess', data);
    };

    that.callbacks.abort = function(that, config){
        that.triggerEvent('onAbort');
    };

    /* *** RENDER *** */

    that.callbacks.clearError = function(that){
        // Clear notification
        that.clearNotification();
        // Clear field errors
        cm.forEach(that.fields, function(field){
            field['controller'].clearError();
        });
    };

    that.callbacks.renderError = function(that, errors, message){
        var hasMessage = !cm.isEmpty(message) && cm.isString(message),
            label = hasMessage ? message : that.lang('form_error'),
            messages;
        // Clear old errors messages
        that.callbacks.clearError(that);
        // Render new errors messages
        if(cm.isArray(errors) || cm.isObject(errors)){
            messages = that.callbacks.renderErrorMessages(that, errors);
            if(that.params['showNotifications']){
                that.callbacks.renderNotification(that, {
                    'label' : label,
                    'type' : 'danger',
                    'messages' : messages,
                    'collapsed' : true
                });
            }
        }else if(hasMessage){
            if(that.params['showNotifications']){
                that.callbacks.renderNotification(that, {
                    'label' : label,
                    'type' : 'danger'
                });
            }
        }else{
            if(that.params['showNotifications']){
                that.callbacks.renderNotification(that, {
                    'label' : that.lang('server_error'),
                    'type' : 'danger'
                });
            }
        }
    };

    that.callbacks.renderErrorMessages = function(that, errors){
        var field,
            fieldName,
            fieldMessage,
            messages = [];
        cm.forEach(errors, function(item, key){
            // Get field
            fieldName = item && item['field'] ? item['field'] : key;
            field = that.getField(fieldName);
            // Render field messages
            if(cm.isObject(item)){
                if(cm.isArray(item['message'])){
                    cm.forEach(item['message'], function(messageItem){
                        fieldMessage = that.lang(messageItem);
                        messages.push(fieldMessage);
                        field && field['controller'].renderError(fieldMessage);
                    })
                }else if(!cm.isEmpty(item['message'])){
                    fieldMessage = that.lang(item['message']);
                    messages.push(fieldMessage);
                    field && field['controller'].renderError(fieldMessage);
                }
            }else if(!cm.isEmpty(item)){
                fieldMessage = that.lang(item);
                messages.push(fieldMessage);
                field && field['controller'].renderError(fieldMessage);
            }
        });
        return messages;
    };

    that.callbacks.renderNotification = function(that, o){
        cm.addClass(that.nodes['notifications'], 'is-show', true);
        that.components['notifications'].add(o);
    };

    /* ******* PUBLIC ******* */

    that.destruct = function(){
        if(!that._isDestructed){
            that._isDestructed = true;
            cm.forEach(that.fields, function(field){
                field['controller'].destruct();
            });
            that.removeFromStack();
            that.params['removeOnDestruct'] && cm.remove(that.nodes['container']);
        }
        return that;
    };

    that.add = function(type, params){
        renderField(type, params);
        return that;
    };

    that.addButton = function(o){
        renderButton(o);
        return that;
    };

    that.addButtons = function(o){
        if(cm.isArray(o)){
            cm.forEach(o, function(item){
                renderButton(item);
            });
        }
        return that;
    };

    that.addSeparator = function(params){
        renderSeparator(params);
        return that;
    };

    that.addConstraint = function(constraint){
        if(cm.isFunction(constraint)){
            cm.arrayAdd(that.constraints, constraint);
        }
        return that;
    };

    that.removeConstraint = function(constraint){
        if(cm.isFunction(constraint)){
            cm.arrayRemove(that.constraints, constraint);
        }
        return that;
    };

    that.appendChild = function(node){
        cm.appendChild(node, that.nodes['fields']);
        return that;
    };

    that.getField = function(name){
        return that.fields[name];
    };

    that.setFieldParams = function(name, params){
        var field = that.getField(name);
        if(field){
            field = cm.merge(field, params);
            // Save
            that.fields[name] = field;
        }
        return that;
    };

    that.removeField = function(name){
        removeField(name);
        return that;
    };

    that.get = function(type){
        var o = {},
            handler,
            pathHandler,
            value,
            path;
        // Validate
        type = cm.inArray(['all', 'fields', 'send', 'sendPath', 'system'], type) ? type : 'fields';
        // Handler
        handler = function(field, name){
            value = field['controller'].get();
            if(that.params['sendOnlyChangedFields']){
                value = cm.getDiffCompare(field['originValue'], value);
            }
            if(!cm.isUndefined(value) && (that.params['sendEmptyFields'] || !cm.isEmpty(value))){
                o[name] = value;
            }
        };
        pathHandler = function(field, name){
            value = field['controller'].get();
            if(that.params['sendOnlyChangedFields']){
                value = cm.getDiffCompare(field['originValue'], value);
            }
            if(!cm.isUndefined(value) && (that.params['sendEmptyFields'] || !cm.isEmpty(value))){
                if(!cm.isEmpty(field['sendPath'])){
                    path = cm.objectFormPath(field['sendPath'], value);
                    o = cm.merge(o, path);
                }else{
                    o[name] = value;
                }
            }
        };
        // Get
        cm.forEach(that.fields, function(field, name){
            switch(type){
                case 'all':
                    handler(field, name);
                    break;
                case 'fields':
                    if(!field['system']){
                        handler(field, name);
                    }
                    break;
                case 'send':
                    if(field['send'] && !field['system']){
                        handler(field, name);
                    }
                    break;
                case 'sendPath':
                    if(field['send'] && !field['system']){
                        pathHandler(field, name);
                    }
                    break;
                case 'system':
                    if(field['system']){
                        handler(field, name);
                    }
                    break;
            }
        });
        return o;
    };

    that.getAll = function(){
        return that.get('all');
    };

    that.set = function(data, triggerEvents){
        var field, setValue;
        cm.forEach(data, function(value, name){
            field = that.fields[name];
            if(field && !field['system']){
                setValue = data[field['dataName']] || value;
                that.fields[name]['controller'].set(setValue, triggerEvents);
            }
        });
        that.triggerEvent('onSet');
        return that;
    };

    that.clear = function(){
        cm.forEach(that.fields, function(field){
            field['controller'].destruct();
        });
        that.fields = {};
        cm.clearNode(that.nodes['fields']);
        cm.forEach(that.buttons, function(button){
            cm.remove(button.node);
        });
        that.buttons = {};
        cm.clearNode(that.nodes['buttonsHolder']);
        that.clearError();
        that.triggerEvent('onClear');
        return that;
    };

    that.reset = function(){
        cm.forEach(that.fields, function(field){
            field['controller'].reset();
        });
        that.clearError();
        that.triggerEvent('onReset');
        return that;
    };

    that.validate = function(){
        var data = validateHelper();
        // Clear previous notifications
        that.clearNotification();
        // Show new notifications if exists
        if(!data['valid']){
            if(that.params['showNotifications'] && that.params['showValidationNotification']){
                that.renderNotification({
                    'label' : data['message'],
                    'type' : 'danger'
                });
            }
        }
        that.triggerEvent('onValidate', data);
        return data;
    };

    that.send = function(){
        var data = {
            'valid' : true
        };
        // Validate
        if(that.params['validate']){
            data = that.validate();
        }
        // Send
        if(data['valid']){
            if(that.isRequest){
                that.requestHandler = that.callbacks.request(that, cm.clone(that.params['request']));
            }else{
                that.clearError(that);
                that.triggerEvent('onSendStart', that.get());
                that.triggerEvent('onSend', that.get());
                that.triggerEvent('onSendEnd', that.get());
            }
        }
        return that;
    };

    that.abort = function(){
        if(that.requestHandler && that.requestHandler.abort){
            that.requestHandler.abort();
        }
        return that;
    };

    that.setAction = function(o, mode, update){
        mode = cm.inArray(['raw', 'update', 'current'], mode)? mode : 'current';
        switch(mode){
            case 'raw':
                that.params['request'] = cm.merge(that._raw.params['request'], o);
                break;
            case 'current':
                that.params['request'] = cm.merge(that.params['request'], o);
                break;
            case 'update':
                that.params['request'] = cm.merge(that._update.params['request'], o);
                break;
        }
        if(update){
            that._update.params['request'] = cm.clone(that.params['request']);
        }
        that.isRequest = that.params['request'] && !cm.isEmpty(that.params['request']['url']);
        return that;
    };

    that.renderNotification = function(o){
        that.callbacks.renderNotification(that, o);
        return that;
    };

    that.clearNotification = function(){
        cm.removeClass(that.nodes['notifications'], 'is-show', true);
        that.components['notifications'].clear();
        return that;
    };

    that.renderError = function(errors, message){
        that.callbacks.renderError(that, errors, message);
        return that;
    };

    that.clearError = function(){
        that.callbacks.clearError(that);
        return that;
    };

    that.showLoader = function(isImmediately){
        that.components['loader'] && that.components['loader'].open(isImmediately);
        return that;
    };

    that.hideLoader = function(isImmediately){
        that.components['loader'] && that.components['loader'].close(isImmediately);
        return that;
    };


    that.getName = function(){
        return that.params['name'];
    };

    that.getContainer = function(){
        return that.nodes['container'];
    };

    that.getButtonsContainer = function(){
        return that.nodes['buttonsContainer'];
    };

    init();
});
