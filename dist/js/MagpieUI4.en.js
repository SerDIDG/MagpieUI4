cm._lang = 'en';
cm._config.displayDateFormatCase = 'nominative';
cm._config.displayDateFormat = '%F %j, %Y';
cm._config.displayDateTimeFormat = '%F %j, %Y, %H:%i';

cm._messages = {
	'common' : {
		'server_error' : 'An unexpected error has occurred. Please try again later.'
	},
	'months' : ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
	'days' : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
	'daysAbbr' : ['S', 'M', 'T', 'W', 'T', 'F', 'S']
};

cm.setMessages('Com.AbstractContainer', {
    'title': 'Container',
    'close': 'Close',
    'save': 'Save',
    'help': '',
});

cm.setMessages('Com.AbstractFileManagerContainer', {
	'title_single' : 'Please select a file',
	'title_multiple' : 'Please select files',
	'close' : 'Cancel',
	'save' : 'Select'
});

cm.setMessages('Com.AbstractFormField', {
	'required' : 'This field is required.',
	'too_short' : 'Value should be at least %count% characters.',
	'too_long' : 'Value should be less than %count% characters.',
	'*' : '*'
});

cm.setMessages('Com.Calendar', {
	'months' : cm._messages.months,
	'days' : cm._messages.days,
	'daysAbbr' : cm._messages.daysAbbr
});

cm.setMessages('Com.CalendarEvents', {
	'months' : cm._messages.months,
	'days' : cm._messages.days,
	'daysAbbr' : cm._messages.daysAbbr
});

cm.setMessages('Com.Dialog', {
    'closeTitle': 'Close',
    'close': '',
    'helpTitle': 'Help',
    'help': '',
});

cm.setMessages('Com.DialogContainer', {
    'close': 'Close',
});

cm.setMessages('Com.FileDropzone', {
	'drop_single' : 'drop file here',
	'drop_multiple' : 'drop files here'
});

cm.setMessages('Com.Form', {
	'form_error' : 'Form is not filled correctly.',
	'server_error' : cm._messages.common['server_error'],
	'success_message' : 'Form successfully sent'
});

cm.setMessages('Com.Gridlist', {
	'counter' : 'Count: %count%',
	'check_all' : 'Check all',
	'uncheck_all' : 'Uncheck all',
	'empty' : 'No items',
	'actions' : 'Actions'
});

cm.setMessages('Com.GridlistFilter', {
	'placeholder' : 'Type query...',
	'search' : '',
	'clear' : 'Clear'
});

cm.setMessages('Com.MultipleField', {
	'add' : 'Add',
	'remove' : 'Remove'
});

cm.setMessages('Com.Notifications', {
	'close' : 'Close',
	'more' : 'Read more'
});

cm.setMessages('Com.Pagination', {
	'prev' : 'Previous',
	'next' : 'Next',
	'server_error' : cm._messages.common['server_error']
});

cm.setMessages('Com.Palette', {
	'new' : 'new',
	'previous' : 'previous',
	'select' : 'Select',
	'hue' : 'Hue',
	'opacity' : 'Opacity',
	'hex' : 'HEX'
});

cm.setMessages('Com.Request', {
	'server_error' : cm._messages.common['server_error']
});

cm.setMessages('Com.ScrollPagination', {
	'load_more' : 'Load More',
	'server_error' : cm._messages.common['server_error']
});

cm.setMessages('Com.TabsetHelper', {
	'server_error' : cm._messages.common['server_error']
});

cm.setMessages('Com.ToggleBox', {
	'show' : 'Show',
	'hide' : 'Hide'
});

cm.setMessages('Com.Autocomplete', {
	'loader' : 'Searching for <b>"%query%"</b>…',
	'suggestion' : '<b>"%query%"</b> not found. Add?'
});

cm.setMessages('Com.BoxTools', {
	'link' : 'Link',
	'unlink' : 'Unlink'
});

cm.setMessages('Com.ColorPicker', {
	'Transparent' : 'Transparent',
	'Clear' : 'Clear'
});

cm.setMessages('Com.DatePicker', {
	'months' : cm._messages.months,
	'days' : cm._messages.days,
	'daysAbbr' : cm._messages.daysAbbr,
	'Clear date' : 'Clear date',
	'Today' : 'Today',
	'Now' : 'Now',
	'Time' : 'Time:'
});

cm.setParams('Com.DatePicker', {
	'startWeekDay': 0
});

cm.setMessages('Com.DateSelect', {
	'months' : cm._messages.months,
	'Day' : 'Day',
	'Month' : 'Month',
	'Year' : 'Year'
});

cm.setMessages('Com.FileInput', {
	'browse' : 'Browse',
	'browse_local' : 'Browse Local',
	'browse_filemanager' : 'Browse File Manager',
	'remove' : 'Remove',
	'open' : 'Open'
});

cm.setMessages('Com.MultipleFileInput', {
	'browse' : 'Browse',
	'browse_local' : 'Browse Local',
	'browse_filemanager' : 'Browse File Manager'
});

cm.setMessages('Com.ImageInput', {
	'preview' : 'Preview',
	'edit' : 'Edit',
	'remove' : 'Remove',
	'browse' : 'Browse'
});

cm.setMessages('Com.RepeatTools', {
	'no-repeat' : 'No',
	'repeat-x' : 'Horizontally',
	'repeat-y' : 'Vertically',
	'repeat' : 'Both'
});

cm.setMessages('Com.ScaleTools', {
	'auto' : 'Auto',
	'contain' : 'Contain',
	'cover' : 'Cover',
	'100% 100%' : 'Fill'
});

cm.setMessages('Com.TagsInput', {
	'tags' : 'Tags',
	'add' : 'Add',
	'remove' : 'Remove',
	'placeholder' : 'Add tags...'
});

cm.setMessages('Com.TimeSelect', {
	'separator' : ':',
	'Hours' : 'HH',
	'Minutes' : 'MM',
	'Seconds' : 'SS',
	'HoursTitle' : 'Hours',
	'MinutesTitle' : 'Minutes',
	'SecondsTitle' : 'Seconds'
});

cm.setMessages('Com.TwoSideMultiSelect', {
	'firstLabel' : 'Left:',
	'secondLabel' : 'Right:',
	'add' : '>>',
	'remove' : '<<',
	'addTitle' : 'Add',
	'removeTitle' : 'Remove'
});
