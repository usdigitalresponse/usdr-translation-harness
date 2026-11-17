from django import forms
from django.utils.translation import gettext_lazy as _


class ApplicationForm(forms.Form):
    household_size = forms.IntegerField(
        label=_("Household size"),
        min_value=1,
    )
    monthly_income = forms.DecimalField(
        label=_("Monthly income before taxes"),
        help_text=_("Include wages, child support and Social Security. If your income is over $4,000 a month, you may not qualify."),
    )
    id_document = forms.FileField(
        label=_("Upload a copy of your driver's license or state ID"),
    )

    def clean_household_size(self):
        size = self.cleaned_data["household_size"]
        if size > 20:
            raise forms.ValidationError(_("Enter a number between 1 and 20."))
        return size
