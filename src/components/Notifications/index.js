cm.define('Com.Notifications', {
    'extend' : 'Com.AbstractController',
    'events' : [
        'onAdd',
        'onRemove'
    ],
    'params' : {
        'renderStructure' : true,
        'embedStructureOnRender' : true,
        'embedStructure' : 'append',
        'icon' : 'icon small remove linked',
        'Com.ToggleBox' : {
            'toggleTitle' : false,
            'className' : null,
            'duration' : 'cm._config.animDuration',
        }
    }
},
function(params){
    var that = this;
    // Call parent class construct
    Com.AbstractController.apply(that, arguments);
});

cm.getConstructor('Com.Notifications', function(classConstructor, className, classProto, classInherit){
    classProto.construct = function(){
        var that = this;
        that.items = [];
        // Call parent method - construct
        classInherit.prototype.construct.apply(that, arguments);
    };

    classProto.renderView = function(){
        var that = this;
        that.nodes['container'] = cm.node('div', {'class' : 'com__notifications'},
            that.nodes['list'] = cm.node('ul')
        );
    };

    classProto.clear = function(){
        var that = this;
        while(that.items.length){
            that.remove(that.items[0]);
        }
        return that;
    };

    classProto.add = function(item){
        var that = this;
        // Config
        item = cm.merge({
            'label' : '',
            'type' : 'warning',           // success | warning | danger
            'messages' : [],
            'collapsed' : true,
            'nodes' : {}
        }, item);
        // Structure
        item['nodes']['container'] = cm.node('li', {'class' : item['type']},
            item['nodes']['close'] = cm.node('div', {'class' : that.params['icon'], 'title' : that.message('close')}),
            item['nodes']['descr'] = cm.node('div', {'class' : 'descr'}),
            item['nodes']['messages'] = cm.node('div', {'class' : 'messages'},
                item['nodes']['messagesList'] = cm.node('ul')
            )
        );
        // Label
        if(!cm.isNode(item['label']) && !cm.isTextNode(item['label'])){
            item['label'] = cm.node('div', {'innerHTML' : item['label']});
        }
        cm.appendChild(item['label'], item['nodes']['descr']);
        // Messages
        if(!cm.isEmpty(item['messages'])){
            // Button
            item['nodes']['button'] = cm.node('a', {'class' : 'more'}, that.message('more'));
            cm.insertFirst(item['nodes']['button'], item['nodes']['descr']);
            // List
            cm.forEach(item['messages'], function(message){
                cm.appendChild(cm.node('li', message), item['nodes']['messagesList']);
            });
            // Toggle
            cm.getConstructor('Com.ToggleBox', function(classConstructor){
                item['controller'] = new classConstructor(
                    cm.merge(that.params['Com.ToggleBox'], {
                        'nodes' : {
                            'container' : item['nodes']['container'],
                            'button' : item['nodes']['button'],
                            'target' : item['nodes']['messages']
                        }
                    })
                );
            });
        }
        // Events
        cm.addEvent(item['nodes']['close'], 'click', function(){
            that.remove(item);
        });
        // Embed
        cm.appendChild(item['nodes']['container'], that.nodes['list']);
        // Push
        that.items.push(item);
        that.triggerEvent('onAdd', item);
        return that;
    };

    classProto.remove = function(item){
        var that = this;
        cm.remove(item['nodes']['container']);
        cm.arrayRemove(that.items, item);
        that.triggerEvent('onRemove', item);
        return that;
    };

    classProto.getLength = function(){
        var that = this;
        return that.items.length;
    };
});
