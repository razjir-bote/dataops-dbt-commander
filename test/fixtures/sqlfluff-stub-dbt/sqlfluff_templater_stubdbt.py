"""Integration-test stand-in for sqlfluff-templater-dbt.

Registers a templater named "dbt" that refuses stdin exactly as the real one does ("The dbt templater does not
support stdin input") and otherwise renders like the jinja templater, so the tests need neither the real plugin
nor a dbt profile.
"""
from sqlfluff.core.errors import SQLFluffUserError
from sqlfluff.core.plugin import hookimpl
from sqlfluff.core.templaters.jinja import JinjaTemplater


class StubDbtTemplater(JinjaTemplater):
    name = "dbt"

    def process(self, *, fname, in_str=None, config=None, formatter=None):
        if fname == "stdin":
            raise SQLFluffUserError("The dbt templater does not support stdin input, provide a path instead")
        return super().process(fname=fname, in_str=in_str, config=config, formatter=formatter)


@hookimpl
def get_templaters():
    return [StubDbtTemplater]
