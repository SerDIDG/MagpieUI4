Com['Tooltip'] = function(o){
    var that = this,
        config = cm.merge({
            'target' : cm.Node('div'),
            'targetEvent' : 'hover',        // hover | click | none
            'hideOnReClick' : false,        // Hide tooltip when re-clicking on the target, requires setting value 'targetEvent' : 'click'
            'top' : 0,                      // Supported properties: targetHeight
            'left' : 0,                     // Supported properties: targetWidth
            'width' : 'auto',               // Supported properties: targetWidth | auto
            'className' : '',
            'title' : '',
            'content' : cm.Node('div'),
            'events' : {}
        }, o),
        API = {
            'onShow' : [],
            'onHide' : []
        },
        checkInt,
        anim,
        isHide = true,
        nodes = {};

    var init = function(){
        // Convert events to API Events
        convertEvents(config['events']);
        // Render structure
        render();
        setMiscEvents();
    };

    var render = function(){
        // Structure
        nodes['container'] = cm.Node('div', {'class' : 'cm-tooltip'},
            nodes['inner'] = cm.Node('div', {'class' : 'inner'},
                nodes['content'] = cm.Node('div', {'class' : 'scroll'})
            )
        );
        // Add css class
        !cm.isEmpty(config['className']) && cm.addClass(nodes['container'], config['className']);
        // Set title
        renderTitle(config['title']);
        // Embed content
        renderContent(config['content']);
    };

    var renderTitle = function(title){
        cm.remove(nodes['title']);
        if(!cm.isEmpty(title)){
            nodes['title'] = cm.Node('div', {'class' : 'title'},
                cm.Node('h3', title)
            );
            cm.insertFirst(nodes['title'], nodes['inner']);
        }
    };

    var renderContent = function(node){
        cm.clearNode(nodes['content']);
        if(node){
            nodes['content'].appendChild(node);
        }
    };

    var setMiscEvents = function(){
        // Init animation
        anim = new cm.Animation(nodes['container']);
        // Add target event
        setTargetEvent();
    };

    var targetEvent = function(){
        if(!isHide && config['targetEvent'] == 'click' && config['hideOnReClick']){
            hide(false);
        }else{
            show();
        }
    };

    var setTargetEvent = function(){
        switch(config['targetEvent']){
            case 'hover' :
                cm.addEvent(config['target'], 'mouseover', targetEvent);
                break;
            case 'click' :
                cm.addEvent(config['target'], 'click', targetEvent);
                break;
        }
    };

    var removeTargetEvent = function(){
        switch(config['targetEvent']){
            case 'hover' :
                cm.removeEvent(config['target'], 'mouseover', targetEvent);
                break;
            case 'click' :
                cm.removeEvent(config['target'], 'click', targetEvent);
                break;
        }
    };

    var show = function(){
        if(isHide){
            isHide = false;
            // Append child tooltip into body and set position
            document.body.appendChild(nodes['container']);
            getPosition();
            // Show tooltip
            nodes['container'].style.display = 'block';
            // Check position
            checkInt = setInterval(getPosition, 5);
            // Animate
            anim.go({'style' : {'opacity' : 1}, 'duration' : 100});
            // Add document target event
            switch(config['targetEvent']){
                case 'hover' :
                    cm.addEvent(document, 'mouseover', bodyEvent);
                    break;
                case 'click' :
                    cm.addEvent(document, 'click', bodyEvent);
                    break;
            }
            /* *** EXECUTE API EVENTS *** */
            executeEvent('onShow');
        }
    };

    var hide = function(immediately){
        if(!isHide){
            isHide = true;
            // Remove event - Check position
            checkInt && clearInterval(checkInt);
            // Remove document target event
            switch(config['targetEvent']){
                case 'hover' :
                    cm.removeEvent(document, 'mouseover', bodyEvent);
                    break;
                case 'click' :
                    cm.removeEvent(document, 'click', bodyEvent);
                    break;
            }
            // Animate
            anim.go({'style' : {'opacity' : 0}, 'duration' : immediately? 0 : 100, 'onStop' : function(){
                nodes['container'].style.display = 'none';
                cm.remove(nodes['container']);
                /* *** EXECUTE API EVENTS *** */
                executeEvent('onHide');
            }});
        }
    };

    var getPosition = function(){
        var targetWidth =  config['target'].offsetWidth,
            targetHeight = config['target'].offsetHeight,
            pageSize = cm.getPageSize();
        // Calculate size
        (function(){
            if(config['width'] != 'auto'){
                var width = eval(config['width'].toString().replace('targetWidth', targetWidth));

                if(width != nodes['container'].offsetWidth){
                    nodes['container'].style.width =  [width, 'px'].join('');
                }
            }
        })();
        // Calculate position
        (function(){
            var top = cm.getRealY(config['target']),
                topAdd = eval(config['top'].toString().replace('targetHeight', targetHeight)),
                left =  cm.getRealX(config['target']),
                leftAdd = eval(config['left'].toString().replace('targetWidth', targetWidth)),
                height = nodes['container'].offsetHeight,
                width = nodes['container'].offsetWidth,
                positionTop = (top + topAdd + height > pageSize['winHeight']? (top - topAdd- height + targetHeight) : top + topAdd),
                positionLeft = (left + leftAdd + width > pageSize['winWidth']? (left - leftAdd - width + targetWidth) : left + leftAdd);

            if(positionTop != nodes['container'].offsetTop){
                nodes['container'].style.top =  [positionTop, 'px'].join('');
            }
            if(positionLeft != nodes['container'].offsetLeft){
                nodes['container'].style.left = [positionLeft, 'px'].join('');
            }
        })();
    };

    var bodyEvent = function(e){
        if(!isHide){
            e = cm.getEvent(e);
            var target = cm.getEventTarget(e);
            if(!cm.isParent(nodes['container'], target, true) && !cm.isParent(config['target'], target, true)){
                hide(false);
            }
        }
    };

    var executeEvent = function(event){
        var handler = function(){
            cm.forEach(API[event], function(item){
                item(that, nodes['content']);
            });
        };

        switch(event){
            default:
                handler();
                break;
        }
    };

    var convertEvents = function(o){
        cm.forEach(o, function(item, key){
            if(API[key] && typeof item == 'function'){
                API[key].push(item);
            }
        });
    };

    /* Main */

    that.setTitle = function(title){
        renderTitle(title);
        return that;
    };

    that.setContent = function(node){
        renderContent(node);
        return that;
    };

    that.setTarget = function(node){
        removeTargetEvent();
        config['target'] = node || cm.Node('div');
        setTargetEvent();
        return that;
    };

    that.show = function(){
        show();
        return that;
    };

    that.hide = function(immediately){
        hide(immediately);
        return that;
    };

    that.isHide = function(){
        return isHide;
    };

    that.addEvent = function(event, handler){
        if(API[event] && typeof handler == 'function'){
            API[event].push(handler);
        }
        return that;
    };

    that.removeEvent = function(event, handler){
        if(API[event] && typeof handler == 'function'){
            API[event] = API[event].filter(function(item){
                return item != handler;
            });
        }
        return that;
    };

    that.getNodes = function(key){
        return nodes[key] || nodes;
    };

    that.remove = function(){
        hide(true);
        removeTargetEvent();
        return that;
    };

    init();
};