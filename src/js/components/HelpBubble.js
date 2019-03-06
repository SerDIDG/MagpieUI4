cm.define('Com.HelpBubble', {
    'modules' : [
        'Params',
        'Events',
        'Langs',
        'DataConfig',
        'DataNodes',
        'Stack'
    ],
    'events' : [
        'onRender'
    ],
    'params' : {
        'node' : cm.Node('div'),
        'name' : '',
        'renderStructure' : false,
        'container' : false,
        'title' : null,
        'content' : cm.node('span'),
        'type' : 'tooltip', // tooltip | container
        'showLabel' : false,
        'Com.Tooltip' : {
            'className' : 'com__help-bubble__tooltip'
        },
        'containerConstructor' : 'Com.DialogContainer',
        'containerParams' : {
            'renderTitle' : true,
            'destructOnClose' : true
        }
    }
},
function(params){
    var that = this;

    that.nodes = {
        'container' : cm.node('span'),
        'button' : cm.node('span'),
        'content' : cm.node('span')
    };

    that.components = {};

    var init = function(){
        that.setParams(params);
        that.convertEvents(that.params['events']);
        that.getDataNodes(that.params['node']);
        that.getDataConfig(that.params['node']);
        render();
        that.addToStack(that.nodes['container']);
        that.triggerEvent('onRender');
    };

    var render = function(){
        // Render structure
        if(that.params['renderStructure']){
            that.nodes['container'] = cm.node('span', {'class' : 'com__help-bubble'},
                that.nodes['button'] = cm.node('span', {'class' : 'com__help-bubble__title'},
                    cm.node('span', {'class' : 'icon default linked'})
                ),
                that.nodes['content'] = cm.node('span', {'class' : 'com__help-bubble__content'})
            );
            // Label
            if(that.params['showLabel']){
                that.nodes['label'] = cm.node('span', {'class' : 'label'}, that.params['title']);
                cm.appendChild(that.nodes['label'], that.nodes['button']);
            }
            // Set Content
            that.set(that.params['content']);
            // Embed
            if(that.params['container']){
                that.params['container'].appendChild(that.nodes['container']);
            }
        }
        // Container
        switch(that.params['type']){
            case 'container':
                // Render container
                cm.getConstructor(that.params['containerConstructor'], function(classConstructor){
                    that.components['container'] = new classConstructor(
                        cm.merge(that.params['containerParams'], {
                            'node' : that.nodes['button'],
                            'title' : that.params['title'],
                            'content' : that.nodes['content']
                        })
                    );
                });
                break;

            default:
                // Render tooltip
                cm.getConstructor('Com.Tooltip', function(classConstructor){
                    that.components['tooltip'] = new classConstructor(that.params['Com.Tooltip']);
                    that.components['tooltip']
                        .setTarget(that.nodes['button'])
                        .setContent(that.nodes['content']);
                });
                break;
        }
    };

    /* ******* PUBLIC ******* */

    that.set = function(node){
        cm.clearNode(that.nodes['content']);
        if(cm.isString(node) || cm.isNumber(node)){
            that.nodes['content'].innerHTML = node;
        }else{
            cm.appendNodes(node, that.nodes['content']);
        }
        return that;
    };

    init();
});