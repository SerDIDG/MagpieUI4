cm._lang = 'ru';
cm._config.displayDateFormatCase = 'genitive';
cm._config.displayDateFormat = '%j %F %Y';
cm._config.displayDateTimeFormat = '%j %F %Y в %H:%i';

cm._strings = {
	'common' : {
		'server_error' : 'Произошла непредвиденная ошибка. Пожалуйста, повторите попытку позже.'
	},
	'months' : {
		'nominative' : ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентярь', 'Октябрь', 'Ноябрь', 'Декабрь'],
		'genitive' : ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентяря', 'октября', 'ноября', 'декабря']
	},
	'days' : ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'],
	'daysAbbr' : ['В', 'П', 'В', 'С', 'Ч', 'П', 'С']
};

cm.setStrings('Com.AbstractContainer', {
    'title': 'Контейнер',
    'close': 'Закрыть',
    'save': 'Сохранить',
    'help': '',
});

cm.setStrings('Com.AbstractFormField', {
	'required' : 'Пожалуйста, заполните поле выше.',
	'too_short' : 'Значение должно содержать минимум %count% символов.',
	'too_long' : 'Значение не должно быть больше %count% символов.',
	'*' : '*'
});

cm.setStrings('Com.Calendar', {
	'months' : cm._strings.months['nominative'],
	'days' : cm._strings.days,
	'daysAbbr' : cm._strings.daysAbbr
});

cm.setStrings('Com.Dialog', {
    'closeTitle': 'Закрыть',
    'close': '',
    'helpTitle': 'Помощь',
    'help': '',
});

cm.setStrings('Com.DialogContainer', {
    'close': 'Закрыть',
});

cm.setStrings('Com.FileDropzone', {
	'drop_single' : 'загрузить файл',
	'drop_multiple' : 'загрузить файлы'
});

cm.setStrings('Com.Form', {
	'form_error' : 'Пожалуйста, корректно заполните все необходимые поля.',
	'server_error' : cm._strings.common['server_error'],
	'success_message' : 'Форма успешно отправлена!'
});

cm.setStrings('Com.Gridlist', {
	'counter' : 'Количество: ',
	'check_all' : 'Выделить все',
	'uncheck_all' : 'Отменить выделение',
	'empty' : 'Список элементов пуст',
	'actions' : 'Действия'
});

cm.setStrings('Com.GridlistFilter', {
	'placeholder' : 'Впишите текст для поиска...'
});

cm.setStrings('Com.MultipleField', {
	'add' : 'Добавить',
	'remove' : 'Удалить'
});

cm.setStrings('Com.Notifications', {
	'close' : 'Закрыть',
	'more' : 'Подробнее'
});

cm.setStrings('Com.Pagination', {
	'prev' : 'Предыдущая',
	'next' : 'Следующая',
	'server_error' : cm._strings.common['server_error']
});

cm.setStrings('Com.ScrollPagination', {
	'load_more' : 'Загрузить ещё',
	'server_error' : cm._strings.common['server_error']
});

cm.setStrings('Com.Autocomplete', {
	'loader' : 'Поиск <b>«%query%»</b>…',
	'suggestion' : 'Добавить <b>«%query%»</b>?'
});

cm.setStrings('Com.DatePicker', {
	'months' : cm._strings.months['genitive'],
	'days' : cm._strings.days,
	'daysAbbr' : cm._strings.daysAbbr,
	'Clear date' : 'Очистить дату',
	'Today' : 'Сегодня',
	'Now' : 'Сейчас',
	'Time' : 'Время:'
});

cm.setParams('Com.DatePicker', {
	'startWeekDay': 1
});

cm.setStrings('Com.DateSelect', {
	'months' : cm._strings.months['nominative'],
	'Day' : 'День',
	'Month' : 'Месяц',
	'Year' : 'Год'
});

cm.setStrings('Com.FileInput', {
	'browse' : 'Обзор',
	'browse_local' : 'Выьрать Локально',
	'browse_filemanager' : 'Выбрать в Файловом Архиве',
	'remove' : 'Удалить',
	'open' : 'Открыть'
});

cm.setStrings('Com.MultipleFileInput', {
	'browse' : 'Обзор',
	'browse_local' : 'Выьрать Локально',
	'browse_filemanager' : 'Выбрать в Файловом Архиве'
});

cm.setStrings('Com.ImageInput', {
	'preview' : 'Просмотр',
	'edit' : 'Редактировать',
	'remove' : 'Удалить',
	'browse' : 'Обзор'
});

cm.setStrings('Com.TagsInput', {
	'tags' : 'Метки',
	'add' : 'Добавить',
	'remove' : 'Удалить',
	'placeholder' : 'Впишите теги, разделяя запятой...'
});
