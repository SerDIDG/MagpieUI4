"use strict";

cm._lang = 'ru';
cm._locale = 'ru-IN';
cm._config.displayDateFormatCase = 'genitive';
cm._config.displayDateFormat = '%j %F %Y';
cm._config.displayDateTimeFormat = '%j %F %Y в %H:%i';
cm._messages = {
  common: {
    'server_error': 'Произошла непредвиденная ошибка. Пожалуйста, повторите попытку позже.'
  },
  months: {
    nominative: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентярь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    genitive: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентяря', 'октября', 'ноября', 'декабря']
  },
  days: ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'],
  daysAbbr: ['В', 'П', 'В', 'С', 'Ч', 'П', 'С']
};
cm.setMessages('Com.AbstractContainer', {
  'title': 'Контейнер',
  'close': 'Закрыть',
  'save': 'Сохранить',
  'help': ''
});
cm.setMessages('Com.AbstractFormField', {
  'required': 'Пожалуйста, заполните поле выше.',
  'too_short': 'Значение должно содержать минимум %count% символов.',
  'too_long': 'Значение не должно быть больше %count% символов.',
  '*': '*'
});
cm.setMessages('Com.Calendar', {
  'months': cm._messages.months['nominative'],
  'days': cm._messages.days,
  'daysAbbr': cm._messages.daysAbbr
});
cm.setMessages('Com.Dialog', {
  'closeTitle': 'Закрыть',
  'close': '',
  'helpTitle': 'Помощь',
  'help': ''
});
cm.setMessages('Com.DialogContainer', {
  'close': 'Закрыть'
});
cm.setMessages('Com.FileDropzone', {
  'drop_single': 'загрузить файл',
  'drop_multiple': 'загрузить файлы'
});
cm.setMessages('Com.Form', {
  'form_error': 'Пожалуйста, корректно заполните все необходимые поля.',
  'server_error': cm._messages.common['server_error'],
  'success_message': 'Форма успешно отправлена!'
});
cm.setMessages('Com.Gridlist', {
  'counter': 'Количество: ',
  'check_all': 'Выделить все',
  'uncheck_all': 'Отменить выделение',
  'empty': 'Список элементов пуст',
  'actions': 'Действия'
});
cm.setMessages('Com.GridlistFilter', {
  'placeholder': 'Впишите текст для поиска...',
  'search': '',
  'clear': 'Очистить'
});
cm.setMessages('Com.MultipleField', {
  'add': 'Добавить',
  'remove': 'Удалить'
});
cm.setMessages('Com.Notifications', {
  'close': 'Закрыть',
  'more': 'Подробнее'
});
cm.setMessages('Com.Pagination', {
  'prev': 'Предыдущая',
  'next': 'Следующая',
  'server_error': cm._messages.common['server_error']
});
cm.setMessages('Com.ScrollPagination', {
  'load_more': 'Загрузить ещё',
  'server_error': cm._messages.common['server_error']
});
cm.setMessages('Com.Autocomplete', {
  'loader': 'Поиск <b>«%query%»</b>…',
  'suggestion': 'Добавить <b>«%query%»</b>?'
});
cm.setMessages('Com.DatePicker', {
  'months': cm._messages.months['genitive'],
  'days': cm._messages.days,
  'daysAbbr': cm._messages.daysAbbr,
  'Clear date': 'Очистить дату',
  'Today': 'Сегодня',
  'Now': 'Сейчас',
  'Time': 'Время:'
});
cm.setParams('Com.DatePicker', {
  'startWeekDay': 1
});
cm.setMessages('Com.DateSelect', {
  'months': cm._messages.months['nominative'],
  'Day': 'День',
  'Month': 'Месяц',
  'Year': 'Год'
});
cm.setMessages('Com.FileInput', {
  'browse': 'Обзор',
  'browse_local': 'Выьрать Локально',
  'browse_filemanager': 'Выбрать в Файловом Архиве',
  'remove': 'Удалить',
  'open': 'Открыть'
});
cm.setMessages('Com.MultipleFileInput', {
  'browse': 'Обзор',
  'browse_local': 'Выьрать Локально',
  'browse_filemanager': 'Выбрать в Файловом Архиве'
});
cm.setMessages('Com.ImageInput', {
  'preview': 'Просмотр',
  'edit': 'Редактировать',
  'remove': 'Удалить',
  'browse': 'Обзор'
});
cm.setMessages('Com.TagsInput', {
  'tags': 'Метки',
  'add': 'Добавить',
  'remove': 'Удалить',
  'placeholder': 'Впишите теги, разделяя запятой...'
});
