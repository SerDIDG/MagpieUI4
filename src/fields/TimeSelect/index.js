cm.define('Com.TimeSelect', {
    'modules' : [
        'Params',
        'Events',
        'Messages',
        'Structure',
        'DataConfig',
        'Stack'
    ],
    'events' : [
        'onRender',
        'onSelect',
        'onChange',
        'onClear'
    ],
    'params' : {
        'node' : cm.node('input', {'type' : 'text'}),
        'container' : null,
        'embedStructure' : 'replace',
        'name' : '',
        'renderSelectsInBody' : true,
        'size' : 'default',                              // default, full, custom
        'format' : 'cm._config.timeFormat',
        'showTitleTag' : true,
        'title' : false,
        'withHours' : true,
        'hoursInterval' : 0,
        'hoursFormat' : 24,
        'withMinutes' : true,
        'minutesInterval' : 0,
        'withSeconds' : false,
        'secondsInterval' : 0,
        'selected' : 0
    }
},
function(params){
    var that = this,
        nodes = {},
        components = {};

    that.date = new Date();
    that.value = 0;
    that.previousValue = 0;
    that.disabled = false;

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataConfig(that.params['node']);
        validateParams();
        render();
        setMiscEvents();
        that.addToStack(nodes['container']);
        // Set selected time
        if(that.params['selected']){
            that.set(that.params['selected'], that.params['format'], false);
        }else{
            that.set(that.params['node'].value, that.params['format'], false);
        }
    };

    var validateParams = function(){
        if(cm.isNode(that.params['node'])){
            that.params['title'] = that.params['node'].getAttribute('title') || that.params['title'];
            that.params['name'] = that.params['node'].getAttribute('name') || that.params['name'];
        }
        if(cm.isEmpty(that.params['hoursInterval']) || that.params['hoursInterval'] === 0){
            that.params['hoursInterval'] = 1;
        }
        if(cm.isEmpty(that.params['minutesInterval']) || that.params['minutesInterval'] === 0){
            that.params['minutesInterval'] = 1;
        }
        if(cm.isEmpty(that.params['secondsInterval']) || that.params['secondsInterval'] === 0){
            that.params['secondsInterval'] = 1;
        }
    };

    var render = function(){
        var hours = 0,
            minutes = 0,
            seconds = 0;
        /* *** STRUCTURE *** */
        nodes['container'] = cm.node('div', {'class' : 'com__timeselect'},
            nodes['hidden'] = cm.node('input', {'type' : 'hidden'}),
            nodes['inner'] = cm.node('div', {'class' : 'inner'})
        );
        if(!cm.isEmpty(that.params['size'])){
            cm.addClass(nodes['container'], ['size', that.params['size']].join('-'));
        }
        /* *** ITEMS *** */
        // Hours
        if(that.params['withHours']){
            renderHours();
        }
        // Minutes
        if(that.params['withMinutes']){
            renderMinutes();
        }
        // Seconds
        if(that.params['withSeconds']){
            renderSeconds();
        }
        // Minutes
        if(that.params['withMinutes']){
            if(nodes['inner'].childNodes.length){
                nodes['inner'].appendChild(cm.node('div', {'class' : 'sep'}, that.message('separator')));
            }
            nodes['inner'].appendChild(cm.node('div', {'class' : 'field'},
                nodes['selectMinutes'] = cm.node('select', {'placeholder' : that.message('Minutes'), 'class' : 'select', 'title' : that.message('MinutesTitle')})
            ));
            while(minutes < 60){
                nodes['selectMinutes'].appendChild(
                    cm.node('option', {'value' : minutes}, cm.addLeadZero(minutes))
                );
                minutes += that.params['minutesInterval'];
            }
        }
        // Seconds
        if(that.params['withSeconds']){
            if(nodes['inner'].childNodes.length){
                nodes['inner'].appendChild(cm.node('div', {'class' : 'sep'}, that.message('separator')));
            }
            nodes['inner'].appendChild(cm.node('div', {'class' : 'field'},
                nodes['selectSeconds'] = cm.node('select', {'placeholder' : that.message('Seconds'), 'class' : 'select', 'title' : that.message('SecondsTitle')})
            ));
            while(seconds < 60){
                nodes['selectSeconds'].appendChild(
                    cm.node('option', {'value' : seconds},cm.addLeadZero(seconds))
                );
                seconds += that.params['secondsInterval'];
            }
        }
        /* *** ATTRIBUTES *** */
        // Title
        if(that.params['showTitleTag'] && that.params['title']){
            nodes['container'].title = that.params['title'];
        }
        // Name
        if(that.params['name']){
            nodes['hidden'].setAttribute('name', that.params['name']);
        }
        /* *** INSERT INTO DOM *** */
        that.embedStructure(nodes['container']);
    };

    var renderHours = function(){
        var hours = 0,
            label;

        if(nodes['inner'].childNodes.length){
            nodes['inner'].appendChild(cm.node('div', {'class' : 'sep'}, that.message('separator')));
        }
        nodes['inner'].appendChild(cm.node('div', {'class' : 'field'},
            nodes['selectHours'] = cm.node('select', {'placeholder' : that.message('Hours'), 'title' : that.message('HoursTitle')})
        ));
        while(hours < 24){
            if(that.params['hoursFormat'] === 24){
                label = cm.addLeadZero(hours);
            }else{
                label = [(hours % 12 || 12), (hours < 12 ? 'am' : 'pm')].join('');
            }
            nodes['selectHours'].appendChild(
                cm.node('option', {'value' : hours}, label)
            );
            hours += that.params['hoursInterval'];
        }
    };

    var renderMinutes = function(){
        var minutes = 0;

        if(nodes['inner'].childNodes.length){
            nodes['inner'].appendChild(cm.node('div', {'class' : 'sep'}, that.message('separator')));
        }
        nodes['inner'].appendChild(cm.node('div', {'class' : 'field'},
            nodes['selectMinutes'] = cm.node('select', {'placeholder' : that.message('Minutes'), 'title' : that.message('MinutesTitle')})
        ));
        while(minutes < 60){
            nodes['selectMinutes'].appendChild(
                cm.node('option', {'value' : minutes}, cm.addLeadZero(minutes))
            );
            minutes += that.params['minutesInterval'];
        }
    };

    var renderSeconds = function(){
        var seconds = 0;

        if(nodes['inner'].childNodes.length){
            nodes['inner'].appendChild(cm.node('div', {'class' : 'sep'}, that.message('separator')));
        }
        nodes['inner'].appendChild(cm.node('div', {'class' : 'field'},
            nodes['selectSeconds'] = cm.node('select', {'placeholder' : that.message('Seconds'), 'title' : that.message('SecondsTitle')})
        ));
        while(seconds < 60){
            nodes['selectSeconds'].appendChild(
                cm.node('option', {'value' : seconds},cm.addLeadZero(seconds))
            );
            seconds += that.params['secondsInterval'];
        }
    };

    var setMiscEvents = function(){
        // Hours select
        if(that.params['withHours']){
            components['selectHours'] = new Com.Select({
                    'node' : nodes['selectHours'],
                    'renderInBody' : that.params['renderSelectsInBody']
                }).addEvent('onChange', function(){
                    set(true);
                });
        }
        // Minutes select
        if(that.params['withMinutes']){
            components['selectMinutes'] = new Com.Select({
                    'node' : nodes['selectMinutes'],
                    'renderInBody' : that.params['renderSelectsInBody']
                }).addEvent('onChange', function(){
                    set(true);
                });
        }
        // Seconds select
        if(that.params['withSeconds']){
            components['selectSeconds'] = new Com.Select({
                    'node' : nodes['selectSeconds'],
                    'renderInBody' : that.params['renderSelectsInBody']
                })
                .addEvent('onChange', function(){
                    set(true);
                });
        }
        // Trigger onRender Event
        that.triggerEvent('onRender');
    };

    var set = function(triggerEvents){
        that.previousValue = that.value;
        that.params['withHours'] && that.date.setHours(components['selectHours'].get());
        that.params['withMinutes'] && that.date.setMinutes(components['selectMinutes'].get());
        that.params['withSeconds'] && that.date.setSeconds(components['selectSeconds'].get());
        that.value = cm.dateFormat(that.date, that.params['format']);
        nodes['hidden'].value = that.value;
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onSelect', that.value);
            onChange();
        }
    };

    var onChange = function(){
        if(!that.previousValue || (!that.value && that.previousValue) || (that.value != that.previousValue)){
            that.triggerEvent('onChange', that.value);
        }
    };

    /* ******* MAIN ******* */

    that.set = function(str, format, triggerEvents){
        format = !cm.isUndefined(format) ? format : that.params['format'];
        triggerEvents = !cm.isUndefined(triggerEvents) ? triggerEvents : true;
        // Get time
        if(cm.isEmpty(str) || typeof str == 'string' && new RegExp(cm.dateFormat(false, that.params['format'])).test(str)){
            that.clear();
            return that;
        }else if(typeof str == 'object'){
            that.date = str;
        }else{
            that.date = cm.parseDate(str, format);
        }
        // Set components
        that.params['withHours'] && components['selectHours'].set(that.date.getHours(), false);
        that.params['withMinutes'] && components['selectMinutes'].set(that.date.getMinutes(), false);
        that.params['withSeconds'] && components['selectSeconds'].set(that.date.getSeconds(), false);
        // Set time
        set(triggerEvents);
        return that;
    };

    that.get = function(){
        return that.value;
    };

    that.getDate = function(){
        return that.date;
    };

    that.getHours = function(){
        return that.date.getHours();
    };

    that.getMinutes = function(){
        return that.date.getMinutes();
    };

    that.getSeconds = function(){
        return that.date.getSeconds();
    };

    that.clear = function(triggerEvents){
        triggerEvents = typeof triggerEvents != 'undefined'? triggerEvents : true;
        // Clear time
        that.date.setHours(0);
        that.date.setMinutes(0);
        that.date.setSeconds(0);
        // Clear components
        that.params['withHours'] && components['selectHours'].set(that.date.getHours(), false);
        that.params['withMinutes'] && components['selectMinutes'].set(that.date.getMinutes(), false);
        that.params['withSeconds'] && components['selectSeconds'].set(that.date.getSeconds(), false);
        // Set time
        set(false);
        // Trigger events
        if(triggerEvents){
            that.triggerEvent('onClear', that.value);
            onChange();
        }
        return that;
    };

    that.disable = function(){
        that.disabled = true;
        that.params['withHours'] && components['selectHours'].disable();
        that.params['withMinutes'] && components['selectMinutes'].disable();
        that.params['withSeconds'] && components['selectSeconds'].disable();
        return that;
    };

    that.enable = function(){
        that.disabled = false;
        that.params['withHours'] && components['selectHours'].enable();
        that.params['withMinutes'] && components['selectMinutes'].enable();
        that.params['withSeconds'] && components['selectSeconds'].enable();
        return that;
    };

    init();
});
