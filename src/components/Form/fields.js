Com.FormFields.add('empty', {
    'field': false,
    'fieldConstructor': 'Com.AbstractFormField',
});

Com.FormFields.add('buttons', {
    'node': cm.node('div', {'class': 'pt__buttons pull-right'}),
    'field': false,
    'system': true,
    'callbacks': {
        'render': function(that) {
            var nodes = {};
            nodes['container'] = that.params['node'];
            nodes['inner'] = cm.node('div', {'class': 'inner'});
            cm.appendChild(nodes['inner'], nodes['container']);
            return nodes;
        },
        'controller': function(that) {
            var buttons = {},
                node;
            cm.forEach(that.params['options'], function(item) {
                node = cm.node('button', {'class': 'button'}, item['text']);
                switch (item['value']) {
                    case 'submit':
                        node.type = 'submit';
                        cm.addClass(node, 'button-primary');
                        cm.addEvent(node, 'click', function(e) {
                            cm.preventDefault(e);
                            that.form.send();
                        });
                        break;

                    case 'reset':
                        node.type = 'reset';
                        cm.addClass(node, 'button-secondary');
                        cm.addEvent(node, 'click', function(e) {
                            cm.preventDefault(e);
                            that.form.reset();
                        });
                        break;

                    case 'clear':
                        cm.addClass(node, 'button-secondary');
                        cm.addEvent(node, 'click', function(e) {
                            cm.preventDefault(e);
                            that.form.clear();
                        });
                        break;

                    default:
                        break;
                }
                buttons[item['value']] = node;
                that.params['node'].appendChild(node);
            });
            return buttons;
        },
    },
});
